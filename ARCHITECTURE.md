# Architecture

## Overview

podpiper turns YouTube channels into podcast RSS feeds on Cloudflare R2. The conversion is modeled as a DAG of cacheable stages where nodes produce file-path outputs and caching is content-addressed.

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
│ yt-dlp:      │──▶│ Structural info  │──▶│ Readiness-loop   │──▶│ Upload files │
│ fetch videos │   │ (node counts)    │   │ DAG scheduler    │   │ to R2        │
└──────────────┘   └──────────────────┘   └──────────────────┘   └──────────────┘
```

**Discovery** fetches the video list via `yt-dlp --flat-playlist`. Not cacheable — the channel might have new videos.

**Analysis** walks the DAG and returns structural info: total node count and count per kind. No cache prediction — the executor handles that.

**Execution** does the real work. Per video: download audio, generate thumbnails, extract chapters, optionally summarize, build an RSS entry. The scheduler dispatches nodes as their dependencies complete, streaming progress events to the CLI.

**Publish** uploads files to R2, fetches existing feed, merges episodes, publishes feed.xml.

## DAG Execution Engine

### Nodes

```typescript
interface Node {
  name: string;
  kind: string;
  deps: string[];
  config: string;
  action: (inputs: Record<string, Outputs>) => Promise<Outputs>;
}
```

Actions take file-path inputs and return file-path outputs. The `Outputs` type is:

```typescript
type Outputs = string | string[] | Record<string, string | string[]>;
```

A single path, a list of paths, or a named record of paths. This separates data identity (file paths) from data content (what's in the files), which is what makes content-hash caching possible.

`kind` groups nodes by type (`"download"`, `"thumbnail"`, `"chapters"`) for progress displays. Not part of the cache hash.

### Content-Hash Caching

Each node's cache key (`actionKey`) is a SHA256 hash of:

- Its name
- Its config string (version tag)
- Its dependencies' names and **content hashes**

This forms a Merkle tree keyed on file content, not execution identity. The cache stores `CacheEntry`:

```typescript
interface CacheEntry {
  outputs: Outputs;      // file paths produced
  contentHash: string;   // SHA256 of actual file contents at those paths
}
```

On cache hit, the executor verifies that files still exist at the cached paths and their content hash matches. If files are missing or corrupted, the node re-executes.

**Early cutoff:** When a node re-executes but produces files with identical content, its `contentHash` is unchanged. Downstream nodes compute the same `actionKey` they had before, get cache hits, and skip execution. This means changing a leaf node's config but getting the same output skips the entire downstream subgraph.

**Config rollback:** Because the cache is content-addressed, reverting a config change hits the original cache entry. No re-execution needed.

Cache interface is async:

```typescript
interface Cache {
  get(key: string): Promise<CacheEntry | undefined>;
  put(key: string, entry: CacheEntry): Promise<void>;
}
```

Three implementations: `MemCache` (in-memory Map), `FsCache` (filesystem-backed, stores manifests as JSON), `TieredCache` (checks local first, promotes remote hits to local).

### Scheduler

The scheduler is a state machine (`packages/dag/src/exec-state.ts`) driven by a readiness loop in the executor.

**State** tracks the work queue (`ready`), in-flight count, a reverse dependency index (`dependents`), per-node content hashes/results, and a failed set.

**Lifecycle:**

1. `createExecState(nodes)` seeds the `ready` queue with zero-dep leaf nodes
2. The executor loop calls `takeNext` to pop a node and increment `inflight`
3. After computing the action key and running the node (or hitting cache), the executor calls `send` with one of: `cache-hit`, `success`, `failure`, or `complete`
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
    await ports.ffmpeg.squareThumbnail(inputs.download.thumb, outputPath);
    return outputPath;
  },
});
```

Config is a static value at definition time — all nodes created from the same action spec share identical config. It can be a string or an object (serialized to JSON automatically).

Params declare what the action needs:

```typescript
interface ThumbnailParams {
  kind: typeof NodeKind.Thumbnail;
  videoId: string;
  outputDir: string;
  deps: { download: NodeRef<DownloadResult> };
}
```

`deps` uses `NodeRef<T>`, so wiring a `NodeRef<TranscribeResult>` where a `NodeRef<DownloadResult>` goes is a compile error. `InputsFor<P>` derives the typed inputs — `inputs.download` is a `DownloadResult`, not a raw string.

Every call site in the graph builder looks the same: `xxx.addNode(graph, ports, params)`.

### JsonPath\<T>

Actions that produce JSON files return `JsonPath<T>` — a phantom-typed string that carries the schema type at compile time but is a plain path at runtime:

```typescript
type JsonPath<T> = string & { readonly __jsonType: T };
```

Readers use `readJson(fs, path)` to deserialize. This prevents mixing path strings with content and ensures type-safe deserialization. Used by `chapters` (`JsonPath<Chapter[]>`), `rss-entry` (`JsonPath<Episode>`), `download` (`JsonPath<YtDlpInfo>`), etc.

## Per-Video Subgraph

```
download ──┬──▶ thumbnail
           ├──▶ chapters
           ├──▶ summary (optional)
           └──▶ rss_entry ◀── thumbnail, chapters, [summary]
```

`download` runs yt-dlp and produces audio.mp3, metadata JSON, thumbnail image, and subtitles.

`thumbnail`, `chapters`, and `summary` all depend on `download` but not each other. They run in parallel.

`rss_entry` waits for all of them, writes episode data and upload manifest as JSON files, and returns their paths.

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

## Result Collection

After execution, the caller reads results from file paths:

```typescript
const results = await graph.execute(localRunner, opts);
for (const ref of entryRefs) {
  const r = resultsByName.get(ref.name);
  const paths = r.outputs as RssEntryResult;
  const episode = await readJson(fs, paths.episode);   // deserialize on demand
  const uploads = await readJson(fs, paths.uploads);
}
```

The executor returns file paths. The caller reads the JSON files to get typed values. Only nodes with status `"done"` (freshly executed) contribute uploads — cached episodes are already on R2.

## Ports

External dependencies are behind interfaces. Swappable with mocks for testing.

| Port                | What it wraps |
| ------------------- | ------------- |
| `FileSystem`        | File I/O      |
| `YouTubeDownloader` | yt-dlp        |
| `MediaProcessor`    | ffmpeg        |
| `Llm`               | LLM API       |
| `ObjectStore`       | S3/R2 storage |

Passed into the pipeline at construction time. Test doubles live in `src/ports/` (mock.ts, stub.ts, memory-fs.ts).

## CLI Display

The CLI (`src/cli/cli.ts`) orchestrates the lifecycle and renders progress via `src/cli/commands/sync/render.ts`:

1. **Analysis summary** — prints total node count with per-kind breakdown
2. **Progress bars** — `cli-progress` multi-bar shows per-kind completion during execution
3. **Final summary** — counts of executed, cached, failed, and dep-failed nodes
