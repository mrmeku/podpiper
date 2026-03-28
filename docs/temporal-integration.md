# Temporal Integration

## The problem: one pipeline, two execution models

The local CLI (`sync`) runs the entire pipeline in a single process. That works for development and small-scale use, but it has limitations: no retry durability (a crash restarts from scratch, modulo cache), no resource isolation (GPU-bound transcription and rate-limited API calls compete for the same thread pool), and no visibility beyond a terminal progress bar.

Temporal solves these. But it has its own execution model — workflows must be deterministic (no I/O, no randomness, no system clocks), and all side-effectful work happens in activities. The question is: how do you take a DAG engine designed for in-process execution and run it across a distributed workflow system without duplicating the scheduling logic?

## dagraph's three execution layers

dagraph separates execution into three layers:

```
execute()        — high-level: validate graph, wire up processNode, pick a scheduler
  └─ orchestrate()  — state machine: track ready/inflight/done, call RunNode callback
       └─ processNode() — atomic unit: cache check, run action, hash outputs, store result
```

`execute()` is the batteries-included entry point the local CLI uses. `orchestrate()` is the lower-level primitive — it takes node descriptors, a `RunNode` callback, and a `Scheduler`, managing which nodes are ready, in-flight, or done. `processNode()` handles a single node's cache-check-execute-hash cycle.

The critical property: `orchestrate()` performs zero I/O. Its state machine is entirely synchronous — map lookups, set mutations, array splices. The only async operations are waiting for the `RunNode` callback and the scheduler to yield. This makes it safe to run inside Temporal's deterministic V8 sandbox.

## The RunNode seam

The entire integration hinges on one type:

```typescript
type RunNode = (
  node: Node,
  depContentHashes: Map<string, string>,
  depOutputs: Record<string, Outputs>,
) => Promise<ProcessNodeResult>;
```

`RunNode` is the callback `orchestrate()` calls for every ready node. Its inputs are all serializable. Its output is a discriminated union (`cached`, `done`, `fail`, `dep-failed`). No closures, no shared mutable state.

Locally, `execute()` provides a `RunNode` that calls `processNode()` directly. In the Temporal workflow, `videoWorkflow` provides one that dispatches to activities:

```typescript
// Local path
const run: RunNode = (desc, depContentHashes, depOutputs) => {
  const node = nodes.get(desc.name)!;
  return processNode(node, depContentHashes, depOutputs, ctx, { force });
};

// Temporal path
const run: RunNode = async (desc, depContentHashes, depOutputs) => {
  const acts = proxyActivities<Activities>(activityOptions(desc.kind));
  return acts[desc.kind as VideoNodeKind]({
    channelName: input.channelName,
    video: input.video,
    nodeName: desc.name,
    kind: desc.kind,
    depContentHashes: Object.fromEntries(depContentHashes),
    depOutputs,
  });
};
```

`orchestrate()` calls both identically. The DAG engine does not know whether it is running locally or distributed.

## The workflow hierarchy

The local CLI runs one `execute()` call over a single large graph. In Temporal, the same work maps to a hierarchy:

```
channelWorkflow (per channel, on cron schedule)
  ├── discover activity → list of new videos + Node[] descriptors
  ├── videoWorkflow (child, per video) ── orchestrate() over the video's DAG
  │     ├── download activity
  │     ├── transcribe activity
  │     ├── thumbnail activity
  │     ├── chapters activity
  │     ├── embed_chapters activity
  │     ├── summary activity
  │     └── rss_entry activity
  ├── channelAvatar activity
  ├── artwork activity
  └── collectAndPublish activity
```

Each video is a child workflow with a deterministic ID (`{channel}-{slug}-{videoId}`), giving idempotency — re-running a channel workflow for the same video is a no-op if the child already completed. Each video workflow has its own event history, retry boundary, and Temporal UI entry. A single video failing does not kill the channel workflow.

Inside each video workflow, `orchestrate()` manages the per-video DAG with `unboundedScheduler()` — all ready nodes dispatch immediately. This is correct because Temporal's task queues handle resource management at the infrastructure level. The in-workflow scheduler only enforces topological ordering.

## The channel branch

Avatar and artwork are not per-video. Locally, they are nodes in the same DAG as everything else. In Temporal, the channel workflow orchestrates them directly:

```typescript
const [videoResults, avatarPath] = await Promise.all([
  Promise.all(videos.map(v => executeChild<typeof videoWorkflow>("videoWorkflow", { ... }))),
  defaultActs.channelAvatarActivity({ channelName: input.channelName }),
]);
const artworkOutputs = await defaultActs.artworkActivity({ channelName, avatarPath });
await defaultActs.collectAndPublish({ channelName, videoOutputs, artworkOutputs });
```

No `orchestrate()` call. Avatar and artwork are a linear chain of 2 steps — `orchestrate()` would add a state machine to manage a topology that is just "do A, then do B." The `Promise.all` that runs video children and the avatar concurrently _is_ the parallelism. Use DAG orchestration where dependency shapes are complex; use plain control flow where they are not.

## Task queue routing

Different actions have different resource profiles. A Whisper transcription occupies a GPU for minutes. A Claude API call is rate-limited. A thumbnail crop takes milliseconds. Each `NodeKind` maps to a task queue with tailored timeouts and retry policies:

```typescript
const TEMPORAL_TASK_CONFIG: Record<NodeKind, TemporalTaskConfig> = {
  download:       { taskQueue: "podpiper-default",  startToCloseTimeout: "30m", retry: { maximumAttempts: 4 } },
  transcribe:     { taskQueue: "podpiper-whisper",  startToCloseTimeout: "15m", retry: { maximumAttempts: 3 } },
  chapters:       { taskQueue: "podpiper-claude",   startToCloseTimeout: "2m",  scheduleToCloseTimeout: "30m" },
  summary:        { taskQueue: "podpiper-claude",   startToCloseTimeout: "2m",  scheduleToCloseTimeout: "30m" },
  thumbnail:      { taskQueue: "podpiper-default",  startToCloseTimeout: "30s"  },
  embed_chapters: { taskQueue: "podpiper-default",  startToCloseTimeout: "2m"   },
  rss_entry:      { taskQueue: "podpiper-default",  startToCloseTimeout: "30s"  },
};
```

Four worker pools consume these queues:

| Worker | Queue | Concurrency | Why |
|---|---|---|---|
| Workflow | `podpiper-workflows` | — | V8 sandbox, pure orchestration |
| Default | `podpiper-default` | 10 | CPU-light I/O: downloads, thumbnails, RSS |
| Whisper | `podpiper-whisper` | 1 | Single GPU slot |
| Claude | `podpiper-claude` | 5 | API rate limit headroom |

The `kind` field on node descriptors — originally for display grouping — is exactly the discriminator needed for task routing. This is the distributed equivalent of dagraph's `concurrencyGroup` + `throttledScheduler`. Locally, `concurrencyGroup: "whisper"` with `concurrencyLimits: { whisper: 1 }` serializes transcription. In Temporal, `taskQueue: "podpiper-whisper"` with `maxConcurrentActivityTaskExecutions: 1` achieves the same constraint through infrastructure.

The Claude activities have both `startToCloseTimeout` (2 minutes for the API call) and `scheduleToCloseTimeout` (30 minutes for queue wait time). Many LLM calls may be queued, but each individual call is fast — the schedule-to-close timeout gives patience for queue backlog without letting a hung call run forever.

## The V8 sandbox boundary

Temporal runs workflow code in a sandboxed V8 isolate. dagraph's `orchestrate()`, `ExecState`, and `unboundedScheduler()` all run inside it. This works because `ExecState` is synchronous (map lookups, set mutations), `orchestrate()` only awaits the `RunNode` callback and the scheduler, and `unboundedScheduler()` is a simple dispatch loop.

The bundler configuration reflects this:

```typescript
export const WORKFLOW_BUNDLER_IGNORE_MODULES = ["crypto", "buffer"];
```

dagraph source is bundled directly into the workflow isolate. The only Node built-ins needing exclusion are `crypto` and `buffer` — conditional imports in the SHA256 library that are never reached in the sandbox (hashing happens in activities, not workflows).

## Walkthrough: what happens when a worker restarts

Suppose a video workflow is processing a 7-node DAG. Download has completed. Thumbnail and transcribe were dispatched in parallel. Thumbnail finished; transcribe is still running on a whisper worker. Then the workflow worker crashes.

Here is what happens, step by step.

**Temporal reschedules the workflow.** The Temporal server notices the workflow worker is gone and assigns the workflow to another workflow worker. The new worker receives the workflow's event history — a log of every activity that was scheduled and every result that was returned.

**`orchestrate()` runs again from the beginning.** The new worker starts `videoWorkflow` from the top. `orchestrate()` initializes a fresh `ExecState`, scans the node descriptors for roots, and finds `download` has no dependencies — it's ready. The scheduler yields it. `orchestrate()` calls the `RunNode` callback.

**Temporal intercepts the activity call.** The `RunNode` callback calls `proxyActivities(...)`, which returns what looks like a normal activity stub. But during replay, Temporal's sandbox intercepts the call. It matches the activity invocation against the event history, finds the recorded result for `download`, and resolves the promise immediately. No activity is dispatched. No worker does any work. `orchestrate()` receives the same `ProcessNodeResult` that the original execution produced.

**The state machine advances deterministically.** `orchestrate()` marks `download` as done, computes which nodes are now ready (thumbnail and transcribe), and calls `RunNode` for both. Again, Temporal matches these against history. Thumbnail's result is in the log — resolved instantly. Transcribe was _scheduled_ but hadn't completed before the crash.

**Temporal handles the in-flight activity.** For transcribe, two things can happen. If the whisper worker finished the transcription after the workflow worker crashed, the result is already in Temporal's event history — the replaying workflow picks it up. If the whisper worker also crashed (or the activity timed out), Temporal's retry policy kicks in: it reschedules the activity on an available whisper worker according to the retry config (`maximumAttempts: 3`).

**Replay catches up; execution resumes.** Once `orchestrate()` has replayed past all historical events, it is back to the state the workflow was in before the crash — but on a new worker, with a rebuilt `ExecState`. From this point forward, new `RunNode` calls dispatch real activities. Chapters, summary, embed_chapters, and rss_entry proceed normally.

The entire recovery happens because `orchestrate()` is deterministic. Given the same node descriptors and the same sequence of `RunNode` results, it makes the same scheduling decisions — same nodes marked ready, same dispatch order, same state transitions. Temporal's replay model depends on this: the workflow must produce the same sequence of activity calls on replay so Temporal can match them against the event history. If `orchestrate()` used wall clocks, random numbers, or non-deterministic iteration order, replay would diverge and the workflow would fail.

There are two layers of caching at work here, and they serve different purposes. Temporal's event history replays _workflow-level_ decisions (which activities were called, what they returned). dagraph's CAS cache, inside `processNode`, caches _action-level_ outputs (the actual files on disk). If Temporal retries a failed activity on a new worker that shares the same filesystem or R2 cache, `processNode` may find a CAS hit and skip the expensive work entirely. The two caches are independent — Temporal doesn't know about the CAS, dagraph doesn't know about event history — but they compose naturally because they operate at different layers.

## Where the two paths diverge

The `RunNode` seam makes the integration possible, but it does not make it free. Three points of divergence are worth understanding.

**Action lookup is duplicated.** dagraph's `Graph` binds actions as closures on `RunnableNode`. Closures are non-serializable, so the Temporal workflow only receives `Node[]` descriptors (via `Graph.describe()`). Each activity must call `buildVideoGraph()` again to recover the closure for a single node. The graph is built twice — once to get descriptors, once per activity to get closures. `buildVideoGraph` is pure, so both calls produce the same graph deterministically.

**Execution routing is mirrored.** dagraph has `concurrencyGroup` for local throttling. Temporal has `TEMPORAL_TASK_CONFIG` for queue routing. Both use `kind` as the discriminator, through separate mechanisms. Adding a new action kind means updating both.

**Channel-level orchestration is structurally different.** Locally, avatar and artwork are DAG nodes. In Temporal, they are imperative activity calls. This is intentional — the channel branch is a linear chain that doesn't benefit from DAG machinery.

The root cause: dagraph models "what to do" as closures, which pins action identity to a single process. The integration works around this cleanly at the serialization boundary. The duplication is manageable, but anyone extending the pipeline should know that changes to actions or execution constraints may need to be reflected in both layers.

## What the seam reveals

The integration touches five files (`workflows.ts`, `activities.ts`, `task-config.ts`, `bundler-config.ts`, `serve.ts`) and zero files inside `packages/dagraph/`. dagraph was not modified. The integration works because dagraph's API has the right shape:

1. **`orchestrate()` is exported separately from `execute()`.** The layered API makes dual-mode operation possible without forking.
2. **`RunNode` is data-in/data-out.** Serializable inputs, discriminated union output. Maps 1:1 onto a Temporal activity call.
3. **`ExecState` is deterministic.** No I/O, no timers, no randomness. Runs in the V8 sandbox unchanged.
4. **`Graph.describe()` separates descriptors from closures.** The workflow receives serializable `Node[]`. Activities rebuild the graph for closures. The descriptor carries enough identity for orchestration; the closure is only needed at execution time.

These properties would enable integration with any orchestrator that separates scheduling from execution — Kubernetes job controllers, cloud function dispatchers, event-driven queues. The Temporal integration is the first consumer, but the seam it exploits is general.
