# Architecture

## Overview

podpiper converts YouTube channels into podcast RSS feeds hosted on Cloudflare R2. It uses a DAG to break the conversion into cacheable stages that run in parallel. If you re-run it, only the parts that changed get recomputed.

## The Pipeline Stages

The pipeline has four layers:

```
 Discovery           Planning              Execution              Publish
┌──────────────┐   ┌──────────────────┐   ┌──────────────────┐   ┌──────────────┐
│ yt-dlp:      │──▶│ Merkle hashes +  │──▶│ Readiness-loop   │──▶│ Upload files  │
│ fetch videos │   │ cache check      │   │ DAG scheduler    │   │ to R2        │
└──────────────┘   └──────────────────┘   └──────────────────┘   └──────────────┘
```

**Discovery** gets the list of videos from YouTube using `yt-dlp --flat-playlist`. This can't be cached since the channel might have new videos.

**Planning** walks the full DAG, computes Merkle hashes, and checks each node against the cache. Returns per-kind cached/dirty counts without running any actions. This powers dry-run mode and the planning summary display.

**Execution** is where the work happens. For each video, we download audio, generate thumbnails, extract chapters, optionally summarize, and build an RSS entry. The readiness-loop scheduler dispatches nodes as soon as their dependencies complete, with live progress events streamed to the CLI.

**Publish** takes a list of files to upload and pushes them to R2. It doesn't know or care what created those files.

## The DAG Execution Engine

### Nodes

A node is just:

```typescript
interface Node {
  name: string;
  kind: string;
  deps: string[];
  config: string;
  action: (inputs: Record<string, string>) => Promise<string>;
}
```

Everything operates on strings. A node takes strings in, returns a string out. This makes caching trivial. Type safety is added on top with `NodeRef<T>` wrappers that parse strings into actual types at the graph-building layer.

`kind` is metadata for reporting — it categorizes nodes (e.g. `"download"`, `"thumbnail"`, `"chapters"`) so the planning phase and progress display can group counts by type. It's not part of the cache hash.

### Caching

Each node's cache key is a hash of:

- Its name
- Its config string (version tag + parameters)
- Its dependencies' names and hashes

This means if you change anything upstream, all downstream hashes automatically change. No manual invalidation needed. Change the download config? Everything that depends on downloads gets re-run. Don't change it? Everything gets cached.

Caches can be layered: `TieredCache(local, remote)` checks local first, then remote, and promotes remote hits to local.

### Planning

Before execution, `graph.plan()` walks the full DAG upfront: computes Merkle hashes, checks each against the cache, and returns per-kind cached/dirty counts. This enables dry-run mode and the planning summary display without running any actions.

### Execution

The graph executor uses a **readiness-loop scheduler**:

1. Builds a reverse-dependency map and seeds a work queue with zero-dep nodes
2. Dispatches ready nodes up to `maxParallelism` concurrency
3. When a node completes, checks its dependents — any whose deps are all done get pushed to the front of the queue
4. If a node fails, marks it and skips anything that depends on it
5. Independent branches keep running
6. Repeats until the queue is empty and nothing is in-flight

Children of completed nodes enter the front of the queue, so downstream work keeps moving forward rather than waiting behind queued siblings. This means if video A's download finishes first, its thumbnail starts immediately without waiting for all other downloads.

### NodeRunner

Execution is delegated through a `NodeRunner` interface:

```typescript
type NodeRunner = (node: Node, inputs: Record<string, string>) => Promise<string>;
```

The default `localRunner` calls `node.action(inputs)` directly. The abstraction exists so execution strategy (local, distributed via Temporal, with retries) can be swapped without changing the executor.

### Progress Events

The executor emits progress events via an optional `onProgress` callback:

- `start` — node execution begins
- `done` — node completed (includes elapsed time)
- `cached` — node skipped (cache hit)
- `fail` — node threw (includes error message and elapsed time)
- `dep-failed` — node skipped because a dependency failed

Events are tagged with `node` name and `kind`, so consumers can group and render progress by category.

## How `sync` Works

The CLI creates the graph and calls `plan()` before handing it to `sync()`:

```typescript
// cli/cli.ts
const graph = new Graph(cache);
const refs = buildPipelineGraph(graph, videos, ports, config);
const plan = graph.plan();
renderPlanSummary(plan);
if (opts.dryRun) return;

const progress = createProgressRenderer(plan);
const result = await sync(graph, refs, {
  maxParallelism: opts.parallel,
  onProgress: progress.onProgress,
});
progress.finish();
```

`sync()` receives a pre-built graph, executes it, and collects upload entries from successful nodes. It returns data, doesn't do uploads. That's the publish step's job.

```typescript
export async function sync(
  graph: Graph,
  refs: PipelineRefs,
  opts?: ExecuteOptions,
): Promise<SyncResult>
```

Key properties:

- You declare dependencies; execution order is derived
- Only changed nodes re-run (automatic incremental updates)
- Data production is separate from data movement (easy to test)
- The CLI controls the plan → render → execute → publish lifecycle

## Per-Video Processing

Each video creates this subgraph:

```
download ──┬──▶ thumbnail
           ├──▶ chapters
           ├──▶ summary (optional)
           └──▶ rss_entry ◀── thumbnail, chapters, [summary]
```

`download` runs yt-dlp and produces audio.mp3, metadata JSON, thumbnail image, and subtitles.

`thumbnail`, `chapters`, and `summary` all depend on `download` but not each other, so they run in parallel.

`rss_entry` waits for all of them, then assembles the episode data and upload manifest.

## Channel-Level Nodes

```
channel_avatar ──▶ artwork
```

`channel_avatar` downloads the channel profile image daily (config includes current date to force refresh).

`artwork` resizes it to 1400×1400.

## The Feed Node

```
[rss_entry:v1, ..., rss_entry:vN, artwork] ──▶ feed
```

`feed` collects all episode entries, fetches the existing feed from R2, merges them (deduplicates, sorts by date), generates RSS XML, and writes it out.

Since it depends on every episode entry, it naturally waits for all videos to finish processing.

## Ports (Dependency Injection)

External dependencies are behind interfaces:

| Port                | What it abstracts |
| ------------------- | ----------------- |
| `FileSystem`        | File I/O          |
| `YouTubeDownloader` | yt-dlp            |
| `MediaProcessor`    | ffmpeg            |
| `Llm`               | LLM API           |
| `ObjectStore`       | S3/R2 storage     |

These get passed into the pipeline at construction. Swap them with mocks for testing.

## CLI Display

The CLI (`src/cli/cli.ts`) orchestrates the full lifecycle and renders progress via `src/cli/render.ts`:

1. **Planning summary** — after `graph.plan()`, prints total node counts and a per-kind breakdown showing cached vs dirty
2. **Progress bars** — during execution, `cli-progress` multi-bar shows per-kind completion. Children of completed nodes run before queued siblings, so bars for downstream stages advance even while upstream work continues
3. **Final summary** — counts of executed, cached, failed, and dep-failed nodes

TTY detection: when stdout is a TTY, uses `cli-progress` with cursor management. When piped, falls back to one log line per completed node.
