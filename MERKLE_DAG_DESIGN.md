# Merkle DAG Pipeline — Design Document

## Overview

A framework for incrementally processing data through a directed acyclic graph (DAG) where each node's identity is a Merkle hash of its configuration and dependency hashes. Unchanged subtrees are skipped entirely. The motivating use case is transforming YouTube channels into podcast feeds, but the framework is designed to generalize to arbitrary data pipelines.

The YouTube-to-podcast pipeline is a deliberately small playground for developing and validating these patterns. Design decisions favor generality over domain-specific optimizations.

## Pipeline Phases

Execution follows four phases, modeled after Bazel's loading/analysis/execution split:

```
Discovery -> Graph Construction -> Execution -> Publish
```

**Discovery** — Always runs. Fetches the current state of the world (e.g., video list for a YouTube channel). Cheap — typically one or a few API calls. Determines what work exists.

**Graph Construction** — Pure function. Takes discovered keys and pipeline config, stamps out a DAG from subgraph templates. Same inputs always produce the same graph with the same hashes. Runs in microseconds. The DAG is not persisted between runs — it is rebuilt from scratch every time because discovery must run anyway to detect source changes, and construction is trivial computation.

**Execution** — Plans, prunes, and executes the DAG (see Executor section below).

**Publish** — Runs after execution, always, unconditionally. Copies final artifacts to the serving layer. Cheap and idempotent.

## Per-Entity Subgraph

Each discovered entity (e.g., video ID) produces an identical DAG shape from a template. The `download` node fetches both media and metadata in a single yt-dlp invocation; all downstream nodes depend on it:

```
download:{id}
  ├── transcribe:{id}
  │     ├── chapters:{id}     ← also depends on download:{id}
  │     └── summary:{id}      ← optional (requires config.summaryPrompt)
  ├── thumbnail:{id}
  └── chapters:{id}

rss_entry:{id}  (depends on: download, transcribe, thumbnail, chapters, [summary])
```

Channel-level nodes run alongside (not per-video):

```
channel_avatar ── artwork
```

There is no `feed` node in the DAG. The `publish()` step runs after DAG execution completes — it uploads artifacts to R2, fetches the existing feed, merges episodes, and publishes `feed.xml`. This is a post-DAG operation, not a graph node.

## Merkle Hashing

Each node's hash is computed from:

- The node's name
- The node's config string (prompt version, model name, transcode settings — anything that affects output)
- The sorted hashes of all dependency nodes

This gives Merkle tree semantics: a change at any leaf propagates upward through all dependents but doesn't affect siblings or unrelated subtrees. Rolling back a config change produces the original hash, which is a cache hit.

## Executor

The executor is the core engine. It handles planning, scheduling, and progress reporting. It is independent of the orchestrator (CLI, Temporal, etc.) and delegates actual node execution to an injected NodeRunner.

### Planning

Before any work runs, the executor performs a planning phase:

1. Walk the full DAG in topological order, compute every Merkle hash, check each against the cache.
2. Classify each node as cached or dirty.
3. Return per-type counts.

```
Full DAG (384 nodes)
    |  planning: hash + cache check (no side effects)
    v
PlanningResult: 349 cached, 35 dirty (per-type breakdown)
    |
    v
Execution: same graph, cached nodes skipped via cache hit (35 run, 349 loaded from cache)
```

The planning phase is cheap (hash computation + cache lookups, no side effects) and provides the complete execution plan before any work begins. Execution uses the same graph — when it encounters a cached node, it loads the result from cache and skips the action.

### Planning Result

The planning phase returns a structured result that any UI can consume:

```
PlanningResult:
  totalCounts:     { total, cached, dirty }             // full DAG summary
  byType:          Map<nodeType, { total, cached, dirty }>  // per-type breakdown
```

The `byType` breakdown gives a UI everything it needs to render per-type progress tracking. For example, a CLI consuming this result can display:

```
Planning complete: 384 nodes, 349 cached, 35 to execute

  download:          47/47 cached
  transcribe:        47/47 cached
  thumbnail:         47/47 cached
  chapters:          35/47 -- 12 to run  ██████████████████████░░░░ 74%
  summary:           35/47 -- 12 to run  ██████████████████████░░░░ 74%
  rss_entry:         37/47 -- 10 to run  ████████████████████████░░ 78%
  channel_avatar:     1/1  cached
  artwork:            1/1  cached
```

A dry-run mode can return the `PlanningResult` without executing anything, allowing users to preview what work would happen before committing to it.

### Readiness-Loop Scheduling

The executor does not run nodes layer by layer. It uses a readiness loop:

1. Identify all nodes in the pruned graph whose dependencies have completed (initially: nodes with no dirty dependencies).
2. Dispatch all ready nodes in parallel via the NodeRunner.
3. As each node completes, recalculate which new nodes are now ready.
4. Repeat until all nodes are done.

This maximizes parallelism. A node runs as soon as its specific dependencies complete, not when its entire depth layer finishes. If `thumbnail` only depends on `video` and `video` completes early, `thumbnail` starts immediately without waiting for `audio`.

### NodeRunner — The Single Swap Point

The executor never calls node actions directly. It delegates to an injected NodeRunner:

```
NodeRunner = (node, inputs) => Promise<result>
```

This is the only interface that changes between execution modes:

```
Orchestrator (CLI / Temporal / Lambda / cron)
    |
Pipeline (discover -> build graph -> execute -> publish)
    |
Executor (planning, pruning, readiness loop, cache, progress)
    |
NodeRunner (local in-process OR Temporal activity OR anything else)
```

**Local runner** — calls `node.action(inputs)` directly. Can wrap with its own retry/backoff logic for flaky operations (YouTube downloads, LLM APIs).

**Temporal runner** — calls `workflow.executeActivity(node.name, inputs, activityOptions)`. Temporal manages retries, timeouts, and heartbeats. Each dirty node becomes a Temporal activity; cached nodes never touch Temporal.

Retry policy lives in the runner, not the executor. The executor says "run this node with these inputs" and the runner decides how.

### Progress Events

During execution, the executor emits progress events via a callback:

```
ProgressEvent:
  node:     string     // "transcript:vid_abc123"
  nodeType: string     // "transcript"
  status:   "start" | "done" | "fail"
```

Progress events are only emitted for dirty nodes — pruned nodes are already fully accounted for in the `PlanningResult`. A CLI updates its per-type progress bars as `done` events arrive:

```
  summary:    35/47 -- 9 remaining  ██████████████████████████░░ 80%  transcribing vid_x7f...
  chapters:   35/47 -- 8 remaining  ███████████████████████████░ 82%
  rss_entry:  37/47 -- 10 remaining ████████████████████████░░░░ 78%
```

A Temporal runner logs events as activity heartbeats. A web UI updates a live DAG visualization. The executor does not know how events are rendered.

### Error Handling

If a node fails, all downstream dependents are skipped with an error. Successful nodes are cached normally. A retry re-runs only the failed node and its dependents — everything else is a cache hit.

## Cache

The cache is an interface:

```
Get(hash) -> result | miss
Put(hash, result)
```

Three implementations:

- **MemCache** — In-memory. For tests.
- **LocalCache** — JSON file on disk. Primary working cache for CLI mode.
- **TieredCache** — Composes two caches. `Get` checks local then remote. `Put` writes through to both. A remote hit pulls into local for next time.

Cache values are strings — file paths, metadata JSON, or short text. Large binary artifacts live in object storage; the cache stores the reference, not the blob.

The cache is content-addressed by Merkle hash, not by node name. This means rolling back a config change is a cache hit — the old hash still exists in the cache.

The cache grows unboundedly. Pruning (LRU, max size, TTL) is a future concern.

### Time Estimation

Wall-clock estimation is imprecise because parallelism and per-node duration vary. The planning phase provides exact counts; progress events provide completion tracking. "What's left" is more reliable than "how long."

If time estimates are needed later, the cache value can be extended to store duration alongside result. Historical durations per node type provide rough estimates. This is an additive change to the cache value format.

## Medallion Architecture

The pipeline follows bronze/silver/gold data layering.

### Bronze — Raw Ingestion

Immutable snapshots of external state. Downloaded from YouTube, stored as-is. Keyed by video ID. Bronze is the only layer that touches the outside world. Video media content is immutable; metadata (title, description, tags) can change, but the current `download` node fetches everything in one yt-dlp invocation.

### Silver — Computed Artifacts

Everything produced by the DAG's transform nodes: transcoded audio, transcripts, summaries, chapters, thumbnails, RSS entries, feed XML. Derived from bronze inputs plus versioned config. Content-addressed in the cache by Merkle hash. Silver is where all compute cost lives — the Merkle DAG minimizes redundant silver computation.

### Gold — Serving Artifacts

The public-facing layer. Stable URLs that podcast clients and CDNs interact with. Gold is not a computation — it is a mapping from stable keys to the latest silver artifacts, written by the publish step.

```
YouTube API / yt-dlp
        |
   +---------+
   |  Bronze  |  Raw downloads, keyed by video ID
   +----+----+
        |  DAG transforms (cached by Merkle hash)
   +---------+
   |  Silver  |  Content-addressed computed artifacts
   +----+----+
        |  Publish step (stable key mapping)
   +---------+
   |   Gold   |  Stable URLs in serving bucket
   +---------+
```

Bronze and silver are content-addressed and append-only. Gold is mutable but updated idempotently. Silver can always be rebuilt from bronze, and gold from silver.

## Storage

| Bucket      | Layer           | Key Scheme                                                       | Visibility                   |
| ----------- | --------------- | ---------------------------------------------------------------- | ---------------------------- |
| **Cache**   | Bronze + Silver | Content-addressed by Merkle hash (bronze also keyed by video ID) | Private                      |
| **Serving** | Gold            | Stable paths (`episodes/{video_id}.mp3`, `feed.xml`)             | Public (Cloudflare R2 + CDN) |

The cache bucket can be local disk, a shared remote store, or tiered. It can be deleted and rebuilt from scratch without affecting the serving bucket. The serving bucket is the gold layer — stable keys, idempotent writes:

```
episodes/{video_id}.mp3   <- audio blob
episodes/{video_id}.png   <- thumbnail
feed.xml                  <- RSS XML
```

## Invalidation Scenarios

Since `download` is a single node containing both media and metadata, any change to a video's metadata re-hashes `download`, which cascades to all its dependents. This is coarser than necessary but matches the current yt-dlp invocation model (one call fetches everything).

| What changed           | What re-runs                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| New video posted       | New video's full subtree (download through rss_entry) + publish                           |
| Video metadata changed | download + all dependents (transcribe, thumbnail, chapters, summary, rss_entry) + publish |
| Summary prompt updated | All summary nodes + all rss_entry nodes + publish                                         |
| Chapter prompt updated | All chapters nodes + all rss_entry nodes + publish                                        |
| Whisper model updated  | All transcribe + chapters + summary + rss_entry + publish                                 |
| Nothing                | Nothing (publish still runs but is idempotent)                                            |
| Config rolled back     | Nothing (content-addressed cache hit)                                                     |

## Scaling with Temporal

At scale (tens of thousands of channels), Temporal provides durable execution, per-channel retry, distributed workers, and scheduling.

### Three-Layer Hierarchy

```
+----------------------------------+
|  Scheduler Workflow (cron)       |  One instance. Controls pacing.
+---------------+------------------+
                |  spawns child workflows
+---------------v------------------+
|  Channel Workflow (per channel)  |  Unit of durability and retry.
+---------------+------------------+
                |  dispatches activities
+---------------v------------------+
|  Activities                      |  Discovery, DAG execution, publish.
+----------------------------------+
```

**Scheduler workflow** — Cron-triggered. Fans out to channel workflows with controlled pacing to avoid thundering herd on YouTube API and Temporal. Detects pipeline config changes and propagates to channel workflows.

**Channel workflow** — One per channel. Sequences discover -> execute -> publish. If a channel fails mid-work, Temporal retries just that channel. The Merkle cache means retries skip completed work.

**Activities and the NodeRunner** — With the local NodeRunner, DAG execution is a single opaque activity per channel. With the Temporal NodeRunner, each dirty node in the pruned graph becomes its own Temporal activity, giving per-node retries, heartbeats, and visibility in the Temporal UI. Cached nodes never become activities — they're pruned before Temporal is involved.

The executor's readiness loop runs inside the channel workflow. The workflow hosts the executor; the executor dispatches nodes via the Temporal NodeRunner. As each activity completes, the executor checks what new nodes are ready and dispatches them. The workflow code is generic — it just runs the executor with the Temporal runner injected.

### No-Change Fast Path

For the common case (channel hasn't posted): one workflow dispatch, one API call, planning finds all hashes cached, zero activities dispatched, done.

### Cache at Scale

With distributed workers, the cache must be remote (S3, Redis). Local disk is a hot layer via TieredCache but not required for correctness.

### Pacing

The scheduler workflow controls: how many channel workflows run in parallel, YouTube API rate budget, and backpressure when workers are saturated. Individual channel workflows are unaware of global concurrency.

### Why a Scheduler, Not Per-Channel Cron

Per-channel cron workflows are simpler but lose pacing control. 30,000 workflows waking simultaneously creates a thundering herd. The scheduler adds one layer of indirection for global rate control and config propagation.

## Design Decisions

**Non-hermetic actions.** LLM calls aren't deterministic. The caching contract is "same inputs + same config = skip," not "same inputs = identical output." To re-run, bump the config version.

**Feed URL is the only stable contract.** Podcast clients subscribe to `feed.xml`. URLs within the feed don't need independent stability — clients re-resolve from the feed. We use stable per-episode URLs for simplicity, not necessity.

**No Cloudflare Worker for URL indirection.** A Worker could map stable URLs to CAS blobs. Rejected to avoid invocation costs. Artifacts upload directly to R2 at stable keys. A Worker can be added later without pipeline changes.

**Custom framework over Dagster/dbt/Temporal.** Dagster's software-defined assets are the closest alternative. The core framework is ~150 lines; the pipeline is a playground for exploring patterns; and Temporal handles orchestration orthogonally to DAG execution. No need for a full platform dependency.

**TypeScript implementation.** The existing pipeline is TypeScript. No reason to rewrite in Go — the framework is language-agnostic and external tools (yt-dlp, ffmpeg, whisper) are subprocesses regardless.

### Future: Granular Metadata Nodes

The current `download` node fetches media and metadata together, so any metadata change (title, description) invalidates the entire subtree including transcription and chapters. A potential optimization is to decompose `download` into granular per-field source nodes (`video_media`, `video_title`, `video_description`) so downstream actions only depend on the fields they use. A title change would then re-run only `thumbnail` and `rss_entry`, not `transcribe`, `chapters`, or `summary`. This requires splitting the yt-dlp invocation or post-processing its output into separate cached fields. Worth considering if metadata churn causes significant redundant compute, but not a priority while the pipeline operates on small channel sizes.

## Implementation Notes

- Node configs must encode everything that affects output: model version, prompt text/version, tool flags, format settings. If it could change the output, it must be in the config string.
- Non-deterministic transforms (LLM outputs) are treated as deterministic for caching purposes. Re-running requires a config version bump.
- External tools (yt-dlp, ffmpeg, whisper) are invoked as subprocesses.
- The NodeRunner interface is the single swap point between local and distributed execution. Everything above it — planning, pruning, readiness loop, cache, progress events — is shared.
