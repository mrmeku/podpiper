# 08 — Temporal Integration

## What

Add a `serve` CLI command that starts a Temporal worker connected to Temporal Cloud. A cron-scheduled workflow runs once daily, iterating all configured channels and running the full sync pipeline (discover → execute → publish) for each. Each dirty DAG node becomes a Temporal activity with per-kind retry policies and timeouts.

## Why

Temporal provides durable execution, automatic retry, cron scheduling, and observability via the Temporal UI. The `serve` command turns podpiper into a long-running service that syncs channels on a schedule without manual intervention. If the process crashes mid-sync, Temporal resumes where it left off on restart.

## Prerequisites

### Generic ActionFunc (plan 06)

Actions must have explicit, serializable params separated from port closures. The `*Params` types, `*Action` factories, `rekeyByRole`, and `planDetailed()` are all needed — see `06-generic-action-func.md`.

### Bun → Node.js Migration (plan 07)

The Temporal TypeScript SDK is incompatible with Bun. The project must run under Node.js first — see `07-replace-bun-for-temporal-compat.md`.

### NodeRunner Abstraction (#3)

Already implemented. `Graph.execute()` accepts a `runner: NodeRunner` parameter. The Temporal channel workflow replaces `localRunner` with activity dispatch.

## Deployment

Single Mac Mini server. No distributed workers, no shared filesystem concerns. Temporal Cloud handles workflow state; the local machine runs a single worker process. Cache stays as `LocalCache` on local disk.

## Architecture

```
src/cli.ts serve
   │
   ├── Connects to Temporal Cloud (mTLS)
   ├── Ensures scheduler workflow exists (cron)
   └── Starts worker (blocks until SIGINT)

┌──────────────────────────────────────────────────┐
│ Temporal Worker                                  │
│                                                  │
│  Workflows:                                      │
│    schedulerWorkflow (cron: "0 0 * * *")         │
│    channelWorkflow(channelName)                  │
│                                                  │
│  Activities:                                     │
│    discoverVideos(channelName)                   │
│    planGraph(channelName, videos)                │
│    executeNode(nodeParams, inputs)               │
│    savePlanCache(channelName, entries)           │
│    publish(channelName, episodes, uploads)       │
└──────────────────────────────────────────────────┘
```

### Workflow Flow

```
Scheduler Workflow (cron: "0 0 * * *")
  │ for each channel in config
  ▼
Channel Workflow (channelName)
  │
  ├─ Activity: discoverVideos(channelName)
  │    → VideoInfo[]
  │
  ├─ Activity: planGraph(channelName, videos)
  │    → DetailedPlan { nodes[], with hash/dirty/cachedResult per node }
  │
  ├─ Workflow logic: readiness loop
  │    Dispatches dirty nodes as activities, respecting deps.
  │    Collects results, enqueues newly-ready children.
  │    ▼
  │  Activity: executeNode(nodeParams, inputs)     ← one per dirty node
  │    → result string
  │
  ├─ Activity: savePlanCache(channelName, hash→result entries)
  │
  └─ Activity: publish(channelName, episodes, uploads)
       → uploads to R2, merges feed, publishes feed.xml
```

### Why the Readiness Loop Lives in the Workflow

The readiness loop orchestrates activity dispatch based on the dependency graph. It must live in the workflow (not an activity) because only workflows can dispatch activities. This partially duplicates the loop in `Graph.execute()`, but the two operate differently:

- **`Graph.execute()`**: computes hashes, checks cache, runs actions — all in one loop
- **Workflow readiness loop**: operates on a pre-computed plan (hashes/cache resolved by `planGraph` activity), dispatches activities and tracks completions

The duplication is ~40 lines of graph traversal. The two contexts have genuinely different constraints (the workflow sandbox can't do I/O or use `node:crypto`).

## Implementation

### NodeParams union — `src/temporal/types.ts`

Each action module exports its `*Params` with the `NodeKind` discriminant and typed `deps` (plan 06). The temporal layer unions them — no field definitions of its own.

```typescript
import type { ArtworkParams, ChannelAvatarParams } from "../pipeline/actions/artwork";
import type { ChaptersParams } from "../pipeline/actions/chapters";
import type { DownloadParams } from "../pipeline/actions/download";
import type { RssEntryParams } from "../pipeline/actions/rss-entry";
import type { SummaryParams } from "../pipeline/actions/summary";
import type { ThumbnailParams } from "../pipeline/actions/thumbnail";
import type { TranscribeParams } from "../pipeline/actions/transcribe";

export type NodeParams =
  | DownloadParams
  | TranscribeParams
  | ThumbnailParams
  | ChaptersParams
  | SummaryParams
  | RssEntryParams
  | ChannelAvatarParams
  | ArtworkParams;
```

### Rebuild — `src/temporal/rebuild.ts`

The switch only binds ports. No params destructuring, no NodeRef construction, no dep name convention. TypeScript narrows `NodeParams` on `kind` for full type safety within each factory.

```typescript
export function rebuildAction(kind: NodeKind, ports: Ports): ActionFunc<any> {
  switch (kind) {
    case NodeKind.Download:
      return downloadAction(ports.ytdlp);
    case NodeKind.Transcribe:
      return transcribeAction(ports.whisper);
    case NodeKind.Thumbnail:
      return thumbnailAction(ports.ffmpeg);
    case NodeKind.Chapters:
      return chaptersAction(ports.fs, ports.claude);
    case NodeKind.Summary:
      return summaryAction(ports.fs, ports.claude);
    case NodeKind.RssEntry:
      return rssEntryAction(ports.fs);
    case NodeKind.ChannelAvatar:
      return channelAvatarAction(ports.ytdlp);
    case NodeKind.Artwork:
      return artworkAction(ports.ffmpeg);
  }
}
```

### New dependencies

```
@temporalio/client
@temporalio/worker
@temporalio/workflow
@temporalio/activity
```

### Connection — `src/temporal/connection.ts`

Reads Temporal Cloud mTLS config from environment:

```typescript
import { readFile } from "node:fs/promises";

import { Connection } from "@temporalio/client";
import { NativeConnection } from "@temporalio/worker";

const TASK_QUEUE = "podpiper";

async function loadTls() {
  return {
    clientCertPair: {
      crt: await readFile(process.env.TEMPORAL_CLIENT_CERT_PATH!),
      key: await readFile(process.env.TEMPORAL_CLIENT_KEY_PATH!),
    },
  };
}

export async function createClientConnection(): Promise<Connection> {
  return Connection.connect({
    address: process.env.TEMPORAL_ADDRESS!,
    tls: await loadTls(),
  });
}

export async function createWorkerConnection(): Promise<NativeConnection> {
  return NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS!,
    tls: await loadTls(),
  });
}
```

### Activities — `src/temporal/activities.ts`

Uses `rebuildAction` to reconstruct the action from `kind` + worker-local ports, then rekeys inputs and calls with explicit params. The action body is identical to local execution.

```typescript
import { rebuildAction } from "./rebuild";
import { rekeyByRole } from "../dag/graph";
import type { NodeParams } from "./types";

const ports = createRealPorts();

export async function executeNode(
  nodeParams: NodeParams,
  inputs: Record<string, string>,
): Promise<string> {
  const action = rebuildAction(nodeParams.kind, ports);
  const rekeyedInputs = rekeyByRole(nodeParams, inputs);
  return action(nodeParams, rekeyedInputs);
}

export async function discoverVideos(channelName: string): Promise<VideoInfo[]> {
  const config = getConfig(channelName);
  return ports.ytdlp.fetchVideoList(config.channelUrl);
}

export async function planGraph(channelName: string, videos: VideoInfo[]): Promise<DetailedPlan> {
  const config = getConfig(channelName);
  const cache = new LocalCache(`${config.outputDir}/cache.json`);
  const graph = new Graph(cache);
  buildPipelineGraph(graph, videos, ports, config);
  return graph.planDetailed();
}

export async function savePlanCache(
  channelName: string,
  entries: Record<string, string>,
): Promise<void> {
  const config = getConfig(channelName);
  const cachePath = `${config.outputDir}/cache.json`;
  const cache = new LocalCache(cachePath);
  for (const [hash, result] of Object.entries(entries)) {
    cache.put(hash, result);
  }
  cache.flush();
}

export async function publishFeed(
  channelName: string,
  episodes: Episode[],
  uploads: UploadEntry[],
): Promise<void> {
  const config = getConfig(channelName);
  await publish({ uploads, results: [], episodes }, config, ports.fs, ports.storage);
}
```

### Workflows — `src/temporal/workflows.ts`

Workflow code runs in Temporal's deterministic sandbox. It cannot import node built-ins or application code — only `@temporalio/workflow` and pure type imports.

```typescript
import * as wf from "@temporalio/workflow";

import type { DetailedNodePlan, DetailedPlan } from "../dag/types";
import type { Episode, UploadEntry, VideoInfo } from "../types";
import type { NodeParams } from "./types";

const { discoverVideos, planGraph, executeNode, savePlanCache, publishFeed } = wf.proxyActivities<
  typeof import("./activities")
>({
  startToCloseTimeout: "5m",
});

// --- Scheduler Workflow ---

export async function schedulerWorkflow(channelNames: string[]): Promise<void> {
  const handles = channelNames.map((name) =>
    wf.startChild(channelWorkflow, {
      args: [name],
      workflowId: `channel-${name}-${Date.now()}`,
    }),
  );
  await Promise.all(handles.map((h) => h.result()));
}

// --- Channel Workflow ---

const ACTIVITY_OPTIONS: Record<string, wf.ActivityOptions> = {
  download: { startToCloseTimeout: "30m", heartbeatTimeout: "5m", retry: { maximumAttempts: 3 } },
  transcribe: { startToCloseTimeout: "60m", heartbeatTimeout: "5m", retry: { maximumAttempts: 3 } },
  thumbnail: { startToCloseTimeout: "5m", retry: { maximumAttempts: 3 } },
  chapters: { startToCloseTimeout: "15m", retry: { maximumAttempts: 3 } },
  summary: { startToCloseTimeout: "15m", retry: { maximumAttempts: 3 } },
  rss_entry: { startToCloseTimeout: "1m", retry: { maximumAttempts: 3 } },
  channel_avatar: { startToCloseTimeout: "10m", retry: { maximumAttempts: 3 } },
  artwork: { startToCloseTimeout: "5m", retry: { maximumAttempts: 3 } },
};

function proxyForKind(kind: string) {
  const opts = ACTIVITY_OPTIONS[kind] ?? { startToCloseTimeout: "10m" };
  return wf.proxyActivities<Pick<typeof import("./activities"), "executeNode">>(opts);
}

export async function channelWorkflow(channelName: string): Promise<void> {
  // 1. Discover
  const videos = await discoverVideos(channelName);
  if (videos.length === 0) return;

  // 2. Plan
  const plan = await planGraph(channelName, videos);
  const dirtyCount = plan.nodes.filter((n) => n.dirty).length;
  if (dirtyCount === 0) return;

  // 3. Execute dirty nodes via readiness loop
  const results: Record<string, string> = {};
  const failed = new Set<string>();

  for (const node of plan.nodes) {
    if (!node.dirty) results[node.name] = node.cachedResult!;
  }

  const nodesByName = new Map(plan.nodes.map((n) => [n.name, n]));
  const dependents = new Map<string, string[]>();
  for (const node of plan.nodes) {
    for (const dep of node.deps) {
      const list = dependents.get(dep) ?? [];
      list.push(node.name);
      dependents.set(dep, list);
    }
  }

  type Pending = Promise<
    { name: string; status: "done"; result: string } | { name: string; status: "fail" }
  >;

  const ready: DetailedNodePlan[] = plan.nodes.filter(
    (n) => n.dirty && n.deps.every((d) => d in results),
  );
  const dispatched = new Set<string>();
  const pending = new Map<string, Pending>();

  while (ready.length > 0 || pending.size > 0) {
    for (const node of ready.splice(0)) {
      dispatched.add(node.name);
      const inputs = Object.fromEntries(node.deps.map((d) => [d, results[d]!]));
      const proxy = proxyForKind(node.kind);
      const p = proxy
        .executeNode(node.params as NodeParams, inputs)
        .then((result) => ({ name: node.name, status: "done" as const, result }))
        .catch(() => ({ name: node.name, status: "fail" as const }));
      pending.set(node.name, p);
    }

    const completed = await Promise.race([...pending.values()]);
    pending.delete(completed.name);

    if (completed.status === "done") {
      results[completed.name] = completed.result;
    } else {
      failed.add(completed.name);
    }

    for (const childName of dependents.get(completed.name) ?? []) {
      if (dispatched.has(childName)) continue;
      const child = nodesByName.get(childName)!;
      if (!child.dirty) continue;
      if (child.deps.some((d) => failed.has(d))) {
        failed.add(childName);
        dispatched.add(childName);
      } else if (child.deps.every((d) => d in results)) {
        ready.push(child);
      }
    }
  }

  // 4. Save cache
  const newCacheEntries: Record<string, string> = {};
  for (const node of plan.nodes) {
    if (node.dirty && results[node.name]) {
      newCacheEntries[node.hash] = results[node.name]!;
    }
  }
  if (Object.keys(newCacheEntries).length > 0) {
    await savePlanCache(channelName, newCacheEntries);
  }

  // 5. Publish
  const episodes: Episode[] = [];
  const uploads: UploadEntry[] = [];
  for (const node of plan.nodes) {
    const result = results[node.name];
    if (!result) continue;
    if (node.kind === "rss_entry") {
      const parsed = JSON.parse(result);
      episodes.push(parsed.episode);
      uploads.push(...parsed.uploads);
    } else if (node.kind === "artwork") {
      const parsed = JSON.parse(result);
      uploads.push(...parsed.uploads);
    }
  }
  if (uploads.length > 0) {
    await publishFeed(channelName, episodes, uploads);
  }
}
```

### Worker — `src/temporal/worker.ts`

```typescript
import { Worker } from "@temporalio/worker";

import * as activities from "./activities";
import { createWorkerConnection } from "./connection";

const TASK_QUEUE = "podpiper";

export async function startWorker(): Promise<Worker> {
  const connection = await createWorkerConnection();
  const worker = await Worker.create({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE!,
    taskQueue: TASK_QUEUE,
    workflowsPath: require.resolve("./workflows"),
    activities,
    maxConcurrentActivityTaskExecutions: 4,
  });
  return worker;
}
```

### CLI `serve` command — add to `src/cli/cli.ts`

```typescript
program
  .command("serve")
  .description("Start Temporal worker and schedule daily sync")
  .option("--schedule <cron>", "Cron schedule", "0 0 * * *")
  .action(async (opts: { schedule: string }) => {
    const channelNames = getAllChannelNames(); // new helper in config.ts
    const client = new Client({
      connection: await createClientConnection(),
      namespace: process.env.TEMPORAL_NAMESPACE!,
    });

    // Ensure scheduler workflow exists (idempotent)
    try {
      await client.workflow.start(schedulerWorkflow, {
        workflowId: "podpiper-scheduler",
        taskQueue: TASK_QUEUE,
        args: [channelNames],
        cronSchedule: opts.schedule,
      });
    } catch (e: any) {
      if (e.name !== "WorkflowExecutionAlreadyStartedError") throw e;
    }

    const worker = await startWorker();
    console.log(`Worker started. Cron: ${opts.schedule}. Ctrl+C to stop.`);
    await worker.run(); // blocks until shutdown
  });
```

## Configuration

### Environment Variables (Temporal Cloud)

```
TEMPORAL_ADDRESS=<namespace>.<account>.tmprl.cloud:7233
TEMPORAL_NAMESPACE=<namespace>.<account>
TEMPORAL_CLIENT_CERT_PATH=/path/to/client.pem
TEMPORAL_CLIENT_KEY_PATH=/path/to/client.key
```

### New helper in `src/config.ts`

```typescript
export function getAllChannelNames(): string[] {
  return Object.keys(channels);
}
```

### Temporal Identifiers

| Identifier            | Value                        |
| --------------------- | ---------------------------- |
| Task queue            | `podpiper`                   |
| Scheduler workflow ID | `podpiper-scheduler`         |
| Channel workflow ID   | `channel-{name}-{timestamp}` |

### Per-Kind Activity Timeouts

| Kind           | startToClose | heartbeat | maxAttempts |
| -------------- | ------------ | --------- | ----------- |
| download       | 30m          | 5m        | 3           |
| transcribe     | 60m          | 5m        | 3           |
| thumbnail      | 5m           | —         | 3           |
| chapters       | 15m          | —         | 3           |
| summary        | 15m          | —         | 3           |
| rss_entry      | 1m           | —         | 3           |
| channel_avatar | 10m          | —         | 3           |
| artwork        | 5m           | —         | 3           |

## File Summary

### New Files

| File                         | Purpose                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| `src/temporal/types.ts`      | `NodeParams` discriminated union — imports from action modules                        |
| `src/temporal/rebuild.ts`    | `rebuildAction(kind, ports)` — reconstructs action from kind + ports via factories    |
| `src/temporal/activities.ts` | Activity implementations: `executeNode` rekeys inputs, calls `action(params, inputs)` |
| `src/temporal/workflows.ts`  | Scheduler + channel workflows (readiness loop)                                        |
| `src/temporal/worker.ts`     | Worker creation and startup                                                           |
| `src/temporal/connection.ts` | Temporal Cloud mTLS connection setup                                                  |

### Modified Files

| File           | Change                   |
| -------------- | ------------------------ |
| `src/cli/cli.ts` | Add `serve` command    |
| `src/config.ts`  | Add `getAllChannelNames()` |
| `package.json`   | Add `@temporalio/*` deps |

## Notes

- **Restart behavior**: Stopping and restarting `serve` is safe. The cron schedule persists in Temporal Cloud. The worker reconnects. In-progress activities are retried by Temporal.
- **Manual trigger**: Use the Temporal UI or `temporal workflow start --type channelWorkflow --task-queue podpiper --input '"heidi"'` to trigger a one-off sync outside the cron schedule.
- **Worker concurrency**: `maxConcurrentActivityTaskExecutions: 4` on the worker controls how many activities run in parallel. Tunable based on Mac Mini resources.
- **Workflow history size**: Each `executeNode` activity adds ~3 events. A channel with 1000 videos produces ~3000 events per sync, well under Temporal's 50K limit.
- **Cache durability**: The `planGraph` activity reads the cache, and `savePlanCache` writes it after execution completes. If the worker crashes mid-sync, the cache isn't updated and Temporal retries the whole channel workflow — nodes re-execute but produce the same results (idempotent).
