# Architecture

## Overview

podpiper turns YouTube channels into podcast RSS feeds on Cloudflare R2. The whole conversion is modeled as a DAG of cacheable stages.

## Configuration

Channels are defined in `src/config.ts` as a `Record<string, ChannelDef>`. Each entry has:

- `channelUrl` — YouTube channel URL
- `r2` — bucket name and public URL for Cloudflare R2
- `podcast` — RSS metadata: title, author, description, Apple category/subcategory
- `chapterPrompt` (optional) — channel-specific instructions for LLM chapter generation
- `summaryPrompt` (optional) — prompt for LLM episode summaries

`getConfig(name)` looks up a channel by key and attaches `outputDir: ./output/{name}`. Global constants `CLAUDE_MODEL` and `WHISPER_MODEL_PATH` set the LLM model and whisper binary path.

## Pipeline Stages

```
 Discovery           Analysis              Execution              Publish
┌──────────────┐   ┌──────────────────┐   ┌──────────────────┐   ┌──────────────┐
│ yt-dlp:      │──▶│ Merkle hashes +  │──▶│ Readiness-loop   │──▶│ Upload files │
│ fetch videos │   │ cache check      │   │ DAG scheduler    │   │ to R2        │
└──────────────┘   └──────────────────┘   └──────────────────┘   └──────────────┘
```

**Discovery** fetches the video list via `yt-dlp --flat-playlist`. Not cacheable — the channel might have new videos.

**Analysis** walks the DAG, computes Merkle hashes, checks each node against the cache. Returns cached/dirty counts per kind. Powers dry-run mode without running any actions.

**Execution** does the real work. Per video: download audio, generate thumbnails, extract chapters, optionally summarize, build an RSS entry. The scheduler dispatches nodes as their dependencies complete, streaming progress events to the CLI.

**Publish** uploads files to R2.

## DAG Execution Engine

### Nodes

```typescript
interface Node {
  name: string;
  kind: string;
  deps: string[];
  params: string;
  config: string;
  action: (rawInputs: Record<string, string>) => Promise<string>;
}
```

Everything operates on strings. A node takes strings in, returns a string out. This makes caching trivial. Type safety is added on top with `NodeRef<T>` wrappers that parse strings into actual types at the graph-building layer.

The framework handles serde: it parses inputs, rekeys them from node names to role names (`"download:abc"` → `"download"`), calls your function with typed objects, and stringifies the result.

`params` holds everything serializable — video ID, output paths, prompts, dep refs. Port closures (filesystem, yt-dlp, ffmpeg) get bound at definition time and stay outside `params`. `params` can be shipped to a remote worker. The worker just needs the action registry and its own ports.

`kind` is the kind of action being executed. It groups nodes by type (`"download"`, `"thumbnail"`, `"chapters"`) so analysis and progress displays can show per-category counts. Not part of the cache hash.

### Caching

Each node's cache key is a hash of:

- Its name
- Its config string (version tag + parameters)
- Its dependencies' names and hashes

A Merkle tree. Change anything upstream and all downstream hashes change automatically.

Caches layer: `TieredCache(local, remote)` checks local first, then remote, promotes remote hits to local.

### Analysis

`graph.analyze()` walks the full DAG before execution. Computes Merkle hashes, checks each against the cache, returns per-node details and per-kind cached/dirty counts.

### Scheduler

The scheduler is a state machine (`src/dag/exec-state.ts`) driven by a readiness loop in the executor.

**State** tracks the work queue (`ready`), in-flight count, a reverse dependency index (`dependents`), per-node hashes/results, and a failed set.

**Lifecycle:**

1. `createExecState(nodes)` seeds the `ready` queue with zero-dep leaf nodes
2. The executor loop calls `takeNext` to pop a node and increment `inflight`
3. After computing the hash and running the node (or hitting cache), the executor calls `send` with one of four actions: `cache-hit`, `success`, `failure`, or `complete`
4. `complete` decrements `inflight` and promotes newly-ready children to the **front** of the queue (`unshift`). A child is ready when all its deps have results and it hasn't been enqueued yet
5. The loop continues while `hasWork` (ready > 0 or inflight > 0), dispatching while `canDispatch` (ready > 0 and under `maxParallelism`)

Front-of-queue insertion keeps related work together. Video A's download finishes, its thumbnail starts immediately instead of waiting behind queued downloads from other videos.

Execution goes through a pluggable `NodeRunner`. The default `localRunner` calls `node.action(inputs)` directly.

## Defining Actions

Each action is a `defineAction` const:

```typescript
export const thumbnail = defineAction<ThumbnailParams, string>({
  name: (p) => `thumbnail:${p.videoId}`,
  config: "crop-v1",
  action: (ports) => async (params, inputs) => {
    const outputPath = `${toVideoDir(params.outputDir, params.videoId)}/thumbnail.jpg`;
    await ports.ffmpeg.cropThumbnail(inputs.download.thumb, outputPath);
    return outputPath;
  },
});
```

Params declare what the action needs:

```typescript
interface ThumbnailParams {
  kind: typeof NodeKind.Thumbnail;
  videoId: string;
  outputDir: string;
  deps: { download: NodeRef<DownloadResult> };
}
```

`deps` uses `NodeRef<T>`, so wiring a `NodeRef<TranscribeResult>` where a `NodeRef<DownloadResult>` goes is a compile error. `InputsFor<P>` derives the typed inputs — `inputs.download` is a `DownloadResult`, not a string you parse.

Every call site in the graph builder looks the same: `xxx.addNode(graph, ports, params)`.

## Per-Video Subgraph

```
download ──┬──▶ thumbnail
           ├──▶ chapters
           ├──▶ summary (optional)
           └──▶ rss_entry ◀── thumbnail, chapters, [summary]
```

`download` runs yt-dlp and produces audio.mp3, metadata JSON, thumbnail image, and subtitles.

`thumbnail`, `chapters`, and `summary` all depend on `download` but not each other. They run in parallel.

`rss_entry` waits for all of them, then assembles the episode data and upload manifest.

## Channel-Level Nodes

```
channel_avatar ──▶ artwork
```

`channel_avatar` downloads the channel profile image. Config includes the current date so it refreshes daily. `artwork` resizes it to 1400x1400.

## Feed Node

```
[rss_entry:v1, ..., rss_entry:vN, artwork] ──▶ feed
```

`feed` collects all episode entries, fetches the existing feed from R2, merges them (deduplicates by ID, sorts by date), generates RSS XML, writes it out. It depends on every episode entry, so it naturally waits for all videos to finish.

## Ports

External dependencies are behind interfaces. Swappable with mocks for testing.

| Port                | What it wraps |
| ------------------- | ------------- |
| `FileSystem`        | File I/O      |
| `YouTubeDownloader` | yt-dlp        |
| `MediaProcessor`    | ffmpeg        |
| `Llm`               | LLM API       |
| `ObjectStore`       | S3/R2 storage |

Passed into the pipeline at construction time.

## CLI Display

The CLI (`src/cli/cli.ts`) orchestrates the lifecycle and renders progress via `src/cli/render.ts`:

1. **Analysis summary** — prints total node counts with per-kind cached/dirty breakdown
2. **Progress bars** — `cli-progress` multi-bar shows per-kind completion during execution
3. **Final summary** — counts of executed, cached, failed, and dep-failed nodes
