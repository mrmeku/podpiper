# 06c — `defineAction` Helper

Builds on 06b.

## What

Add a `defineAction` helper that returns `{ action, addNode }` from a declarative spec. The caller passes `Params` directly — no separate input type. The helper generates the `addNode` wrapper with a uniform signature: `(graph, ports, params)`.

## Why

06b leaves a repetitive pattern in every action file: an `addXxxNode` function that calls `addNode(graph, name, config, params, actionFn(ports))` with slightly different argument lists. Each has a bespoke positional-arg signature, making the graph-builder wire each one differently. `defineAction` makes this declarative — the spec describes `name`, `config`, and `action` binding, and the helper does the plumbing.

## `defineAction`

### `src/pipeline/define-action.ts`

```typescript
import type { Graph } from "@/dag/graph";
import { addNode as graphAddNode } from "@/dag/graph";
import type { ActionFunc, BaseParams, NodeRef } from "@/dag/types";
import type { Ports } from "@/ports/types";

interface ActionSpec<P extends BaseParams, R> {
  name: (params: P) => string;
  config: string | ((params: P) => string);
  action: (ports: Ports) => ActionFunc<P, R>;
}

interface ActionDef<P extends BaseParams, R> {
  action: (ports: Ports) => ActionFunc<P, R>;
  addNode: (graph: Graph, ports: Ports, params: P) => NodeRef<R>;
}

export function defineAction<P extends BaseParams, R>(spec: ActionSpec<P, R>): ActionDef<P, R> {
  return {
    action: spec.action,
    addNode: (graph, ports, params) => {
      const config = typeof spec.config === "string" ? spec.config : spec.config(params);
      return graphAddNode(graph, spec.name(params), config, params, spec.action(ports));
    },
  };
}
```

Lives in `src/pipeline/` (not `src/dag/`) because it hardcodes `Ports`. The DAG library stays generic.

## Action Changes

### Pattern

```typescript
export interface XxxParams {
  kind: typeof NodeKind.Xxx;
  videoId: string;
  deps: { depA: DepName<DepAResult> };
}

export const xxx = defineAction<XxxParams, XxxResult>({
  name: (p) => `xxx:${p.videoId}`,
  config: "xxx-v1",
  action: (ports) => async (params, inputs) => {
    // inputs.depA: DepAResult (typed by framework)
    return result;
  },
});
```

Exported as a single object. Call sites use `xxx.addNode(graph, ports, {...})`. Testing uses `xxx.action(mockPorts)`.

### Transcribe example

**Before:**

```typescript
export interface TranscribeParams {
  kind: typeof NodeKind.Transcribe;
  videoId: string;
  outputDir: string;
  deps: { download: DepName<DownloadResult> };
}

export function transcribeAction(
  whisper: Transcriber,
): ActionFunc<TranscribeParams, TranscribeResult> {
  return async (params, inputs) => {
    const dir = toVideoDir(params.outputDir, params.videoId);
    return whisper.transcribe(inputs.download.audio, dir);
  };
}

export function addTranscribeNode(
  graph: Graph,
  videoId: string,
  download: NodeRef<DownloadResult>,
  whisper: Transcriber,
  outputDir: string,
): NodeRef<TranscribeResult> {
  return addNode(
    graph,
    `transcribe:${videoId}`,
    "whisper-v1,model=medium",
    {
      kind: NodeKind.Transcribe,
      videoId,
      outputDir,
      deps: { download: dep(download) },
    } satisfies TranscribeParams,
    transcribeAction(whisper),
  );
}
```

**After:**

```typescript
export interface TranscribeParams {
  kind: typeof NodeKind.Transcribe;
  videoId: string;
  outputDir: string;
  deps: { download: DepName<DownloadResult> };
}

export const transcribe = defineAction<TranscribeParams, TranscribeResult>({
  name: (p) => `transcribe:${p.videoId}`,
  config: "whisper-v1,model=medium",
  action: (ports) => async (params, inputs) => {
    const dir = toVideoDir(params.outputDir, params.videoId);
    return ports.whisper.transcribe(inputs.download.audio, dir);
  },
});
```

### Chapters example (dynamic config)

```typescript
export interface ChaptersParams {
  kind: typeof NodeKind.Chapters;
  chapterPrompt: string | undefined;
  deps: { download: DepName<DownloadResult>; transcribe: DepName<TranscribeResult> };
}

export const chapters = defineAction<ChaptersParams, Chapter[]>({
  name: (p) => `chapters:${p.deps.download.replace("download:", "")`,
  config: (p) => {
    const promptHash = p.chapterPrompt ? Bun.hash(p.chapterPrompt).toString(36) : "none";
    return `extract-v1,fallback=${promptHash}`;
  },
  action: (ports) => chaptersActionImpl(ports.fs, ports.claude),
});
```

The `config` field is a function here because the cache key depends on the prompt hash. The `action` field can delegate to an existing function when the logic is complex (chapters, summary). Simple actions inline the async function.

Note: the `name` function needs a `videoId`. Since there's no separate Input type, we need it in `ChaptersParams`. Currently it's not there — the `addChaptersNode` function receives it as a separate arg and interpolates it into the name. Two options:

1. Add `videoId` to `ChaptersParams` (and `SummaryParams`). It's already present in most other params. Consistent.
2. Derive it from a dep name (`p.deps.download` is `"download:${videoId}"`). Fragile.

Option 1 is correct — add `videoId` to `ChaptersParams` and `SummaryParams`.

### Rss-entry example (optional dep)

```typescript
export interface RssEntryParams {
  kind: typeof NodeKind.RssEntry;
  video: VideoInfo;
  outputDir: string;
  deps: {
    download: DepName<DownloadResult>;
    transcribe: DepName<TranscribeResult>;
    thumbnail: DepName<string>;
    chapters: DepName<Chapter[]>;
    summary?: DepName<string>;
  };
}

export const rssEntry = defineAction<RssEntryParams, EpisodeOutput>({
  name: (p) => `rss_entry:${p.video.id}`,
  config: "rss-v2",
  action: (ports) => rssEntryActionImpl(ports.fs),
});
```

### Artwork (two-node subgraph)

Artwork has two nodes. Each gets its own `defineAction`. The graph-builder calls both:

```typescript
export interface ChannelAvatarParams {
  kind: typeof NodeKind.ChannelAvatar;
  channelUrl: string;
  avatarDir: string;
}

export const channelAvatar = defineAction<ChannelAvatarParams, string>({
  name: () => "channel_avatar",
  config: (p) => `avatar-v1,date=${new Date().toISOString().slice(0, 10)}`,
  action: (ports) => async (params) => {
    await ports.ytdlp.downloadChannelArtwork(params.avatarDir, params.channelUrl);
    return `${params.avatarDir}/channel_avatar.jpg`;
  },
});

export interface ArtworkParams {
  kind: typeof NodeKind.Artwork;
  artworkPath: string;
  deps: { channel_avatar: DepName<string> };
}

export const artwork = defineAction<ArtworkParams, ArtworkOutput>({
  name: () => "artwork",
  config: "artwork-v1",
  action: (ports) => async (params, inputs) => {
    await ports.ffmpeg.processChannelArtwork(inputs.channel_avatar, params.artworkPath);
    return {
      uploads: [
        { localPath: params.artworkPath, r2Key: "artwork.jpg", cacheControl: "max-age=86400" },
      ],
    };
  },
});
```

`addArtworkNodes` wrapper removed — graph-builder calls `channelAvatar.addNode` then `artwork.addNode` directly.

## Graph-builder Changes

### `src/pipeline/graph-builder.ts`

**Before:**

```typescript
import { addDownloadNode } from "./actions/download";
import { addTranscribeNode } from "./actions/transcribe";
// ... 5 more imports ...

function addVideoSubgraph(graph, video, ports, config) {
  const download = addDownloadNode(graph, video.id, ports.ytdlp, config.outputDir);
  const transcribe = addTranscribeNode(graph, video.id, download, ports.whisper, config.outputDir);
  const thumbnail = addThumbnailNode(graph, video.id, download, ports.ffmpeg, config.outputDir);
  const chapters = addChaptersNode(
    graph,
    video.id,
    download,
    transcribe,
    ports.fs,
    ports.claude,
    config.chapterPrompt,
  );
  // ...
}
```

**After:**

```typescript
import { download } from "./actions/download";
import { transcribe } from "./actions/transcribe";
import { thumbnail } from "./actions/thumbnail";
import { chapters } from "./actions/chapters";
import { summary } from "./actions/summary";
import { rssEntry } from "./actions/rss-entry";
import { channelAvatar, artwork } from "./actions/artwork";

function addVideoSubgraph(graph, video, ports, config) {
  const dl = download.addNode(graph, ports, {
    kind: NodeKind.Download,
    videoId: video.id,
    outputDir: config.outputDir,
  });
  const tr = transcribe.addNode(graph, ports, {
    kind: NodeKind.Transcribe,
    videoId: video.id,
    outputDir: config.outputDir,
    deps: { download: dep(dl) },
  });
  const th = thumbnail.addNode(graph, ports, {
    kind: NodeKind.Thumbnail,
    videoId: video.id,
    outputDir: config.outputDir,
    deps: { download: dep(dl) },
  });
  const ch = chapters.addNode(graph, ports, {
    kind: NodeKind.Chapters,
    videoId: video.id,
    chapterPrompt: config.chapterPrompt,
    deps: { download: dep(dl), transcribe: dep(tr) },
  });
  const baseDeps = {
    download: dep(dl),
    transcribe: dep(tr),
    thumbnail: dep(th),
    chapters: dep(ch),
  };
  if (config.summaryPrompt) {
    const sm = summary.addNode(graph, ports, {
      kind: NodeKind.Summary,
      videoId: video.id,
      summaryPrompt: config.summaryPrompt,
      deps: { download: dep(dl), transcribe: dep(tr) },
    });
    return rssEntry.addNode(graph, ports, {
      kind: NodeKind.RssEntry,
      video,
      outputDir: config.outputDir,
      deps: { ...baseDeps, summary: dep(sm) },
    });
  }
  return rssEntry.addNode(graph, ports, {
    kind: NodeKind.RssEntry,
    video,
    outputDir: config.outputDir,
    deps: baseDeps,
  });
}
```

Every call has the same shape: `xxx.addNode(graph, ports, params)`. Ports are passed once — each action picks what it needs. The `dep()` calls and `kind` discriminants are visible at the call site.

## Params Changes

Add `videoId` to `ChaptersParams` and `SummaryParams` — they need it for the node name but currently receive it only as an `addXxxNode` argument. All other params already have it.

## Removed Exports

The following per-action exports are removed:

- `addDownloadNode`, `addTranscribeNode`, `addThumbnailNode`, `addChaptersNode`, `addSummaryNode`, `addRssEntryNode`, `addArtworkNodes`
- `downloadAction`, `transcribeAction`, `thumbnailAction`, `chaptersAction`, `summaryAction`, `rssEntryAction`, `channelAvatarAction`, `artworkAction`

Replaced by the `xxx.addNode` and `xxx.action` methods on the `defineAction` return object.

Internal action implementations (e.g., `chaptersActionImpl`, `rssEntryActionImpl` — renamed with `Impl` suffix or kept as module-level functions) remain as private helpers within each action file.

## File Summary

| File                                 | Change                                                                                                                            |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `src/pipeline/define-action.ts`      | New. `defineAction<P, R>` helper.                                                                                                 |
| `src/pipeline/actions/download.ts`   | Replace `downloadAction` + `addDownloadNode` with `export const download = defineAction(...)`.                                    |
| `src/pipeline/actions/transcribe.ts` | Replace `transcribeAction` + `addTranscribeNode` with `export const transcribe = defineAction(...)`.                              |
| `src/pipeline/actions/thumbnail.ts`  | Replace `thumbnailAction` + `addThumbnailNode` with `export const thumbnail = defineAction(...)`.                                 |
| `src/pipeline/actions/chapters.ts`   | Replace `chaptersAction` + `addChaptersNode` with `export const chapters = defineAction(...)`. Add `videoId` to `ChaptersParams`. |
| `src/pipeline/actions/summary.ts`    | Replace `summaryAction` + `addSummaryNode` with `export const summary = defineAction(...)`. Add `videoId` to `SummaryParams`.     |
| `src/pipeline/actions/rss-entry.ts`  | Replace `rssEntryAction` + `addRssEntryNode` with `export const rssEntry = defineAction(...)`. Remove `RssEntryDeps`.             |
| `src/pipeline/actions/artwork.ts`    | Replace `channelAvatarAction` + `artworkAction` + `addArtworkNodes` with two `defineAction` exports.                              |
| `src/pipeline/graph-builder.ts`      | Update imports and call sites to use `xxx.addNode(graph, ports, params)`.                                                         |
