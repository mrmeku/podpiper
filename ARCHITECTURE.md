# Architecture

## Overview

podpiper converts YouTube channels into podcast RSS feeds hosted on Cloudflare R2. It uses a DAG to break the conversion into cacheable stages that run in parallel. If you re-run it, only the parts that changed get recomputed.

## The Pipeline Stages

The pipeline has three layers:

```
 Copper (Discovery)        Silver (Pipeline)           Gold (Publish)
┌──────────────────┐   ┌──────────────────────┐   ┌──────────────────
│ yt-dlp: fetch    │──▶│ DAG of per-video     │──▶│ Upload files    │
│ video list       │   │ transforms + feed gen│   │ to R2           │
└──────────────────┘   └──────────────────────┘   └─────────────────┘
```

**Copper** gets the list of videos from YouTube using `yt-dlp --flat-playlist`. This can't be cached since the channel might have new videos.

**Silver** is where the work happens. For each video, we download audio, generate thumbnails, extract chapters, optionally summarize, and build an RSS entry. All of this gets organized as a dependency graph where each step is cached by content hash.

**Gold** takes a list of files to upload and pushes them to R2. It doesn't know or care what created those files.

## The DAG Execution Engine

### Nodes

A node is just:

```typescript
interface Node {
  name: string;
  deps: string[];
  config: string;
  action: (inputs: Record<string, string>) => Promise<string>;
}
```

Everything operates on strings. A node takes strings in, returns a string out. This makes caching trivial. Type safety is added on top with `NodeRef<T>` wrappers that parse strings into actual types at the graph-building layer.

### Caching

Each node's cache key is a hash of:

- Its name
- Its config string (version tag + parameters)
- Its dependencies' names and hashes

This means if you change anything upstream, all downstream hashes automatically change. No manual invalidation needed. Change the download config? Everything that depends on downloads gets re-run. Don't change it? Everything gets cached.

Caches can be layered: `TieredCache(local, remote)` checks local first, then remote, and promotes remote hits to local.

### Execution

The graph executor:

1. Does a topological sort
2. Assigns depths (how far from leaf nodes)
3. Runs all nodes at the same depth in parallel
4. If a node fails, marks it and skips anything that depends on it
5. Independent branches keep running

This gives you wall-clock time equal to the longest chain of dependencies, assuming you have enough parallelism.

## How `sync` Works

```typescript
export async function sync(
  videos: VideoInfo[],
  config: Config,
  ports: Ports,
  cache: Cache,
): Promise<SyncResult> {
  const graph = new Graph(cache);
  buildPipelineGraph(graph, videos, ports, config);
  const results = await graph.execute();
  const uploads: UploadEntry[] = [];
  for (const r of results) {
    if (r.error || r.result === null || r.skipped) continue;
    const output: EpisodeOutput = JSON.parse(r.result);
    uploads.push(...output.uploads);
  }
  return { uploads, results };
}
```

`sync` builds the graph, executes it, and collects upload entries from successful nodes. It returns data, doesn't do uploads. That's the publish step's job.

Key properties:

- You declare dependencies; execution order is derived
- Only changed nodes re-run (automatic incremental updates)
- Data production is separate from data movement (easy to test)

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
