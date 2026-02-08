# 06b — Framework-Owned Serialization + Branded Dep Types

Builds on 06a.

## What

Move all JSON serialization into `addNode` — it parses inputs and stringifies outputs so action bodies never touch `JSON.parse`/`JSON.stringify`. Add branded `DepName<T>` types so `InputsFor` produces parsed types (`DownloadResult`, `Chapter[]`) instead of `string`. `addNode` returns `NodeRef<R>` directly, eliminating `stringRef` and the separate `jsonRef` call.

## Why

06a leaves two ergonomic gaps:

1. **Parse safety regression** — actions manually `JSON.parse(inputs.download)` with an explicit type annotation that the compiler can't verify. The current `NodeRef<T>.parse()` gives typed results; 06a loses that.
2. **Boilerplate** — every action `JSON.stringify`s its return, and every `addXxxNode` constructs a `NodeRef` separately. Both are mechanical and uniform.

Moving serde into the framework closes both gaps.

## Core Type Changes

### `src/dag/types.ts`

```typescript
type DepName<T = unknown> = string & { readonly __resultType?: T };

function dep<T>(ref: NodeRef<T>): DepName<T> {
  return ref.name as DepName<T>;
}

type InputsFor<P> = P extends { deps: infer D }
  ? { [K in keyof D]: D[K] extends DepName<infer T> | undefined
      ? (undefined extends D[K] ? T | undefined : T)
      : unknown }
  : {};

type ActionFunc<P extends BaseParams, R> = (params: P, inputs: InputsFor<P>) => Promise<R>;

interface BaseParams {
  kind: string;
  deps?: Record<string, DepName | undefined>;
}
```

Changes from 06a:

- **`DepName<T>`** — branded string. At runtime it's a plain string (serializable). At compile time the phantom `T` tracks the result type. `dep(transcribeRef)` is not assignable to `DepName<DownloadResult>` — catches miswiring at the call site.
- **`InputsFor`** — now extracts the branded type. `DepName<DownloadResult>` maps to `DownloadResult`, optional deps map to `T | undefined`.
- **`ActionFunc<P, R>`** — gains result type `R`. Actions return typed values directly.
- **`BaseParams.deps`** — values are `DepName | undefined` instead of `string | undefined`.

### `Node.action` reverts to closure form

```typescript
interface Node {
  name: string;
  kind: string;
  deps: string[];
  config: string;
  params: BaseParams;
  action: (rawInputs: Record<string, string>) => Promise<string>;
}
```

`Node.action` is the internal form — takes raw inputs (keyed by node name), returns a serialized string. `addNode` wraps `ActionFunc<P, R>` into this. `localRunner` calls it directly with no transformation.

## `addNode` Changes

### `src/dag/graph.ts`

```typescript
function parseInputs(
  params: BaseParams,
  rawInputs: Record<string, string>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(rekeyByRole(params, rawInputs)).map(([k, v]) => [k, JSON.parse(v)]),
  );
}

export function addNode<P extends BaseParams, R>(
  graph: Graph,
  name: string,
  config: string,
  params: P,
  action: ActionFunc<P, R>,
): NodeRef<R> {
  graph.add({
    name, kind: params.kind, deps: depsFromParams(params), config, params,
    action: async (rawInputs) =>
      JSON.stringify(await action(params, parseInputs(params, rawInputs) as InputsFor<P>)),
  });
  return jsonRef<R>(name);
}

export const localRunner: NodeRunner = (node, rawInputs) => node.action(rawInputs);
```

Changes from 06a:

- **`parseInputs`** — rekeys by role + `JSON.parse`s each value. Produces typed `InputsFor<P>` for the action (cast is safe — framework controls both sides of the round-trip).
- **`addNode` returns `NodeRef<R>`** — via `jsonRef<R>`. No separate ref construction at call sites.
- **`addNode` wraps the action** — `params` captured in closure, inputs parsed, result stringified.
- **`localRunner` simplified** — all rekey/parse/stringify logic is in the wrapped closure.

`rekeyByRole` remains standalone — the future remote runner uses it to translate inputs before sending over the wire.

## `stringRef` Eliminated

All results go through `JSON.stringify`/`JSON.parse` uniformly. Raw string returns (thumbnail path, summary text) become `JSON.stringify("path")` → `'"path"'`, and `JSON.parse('"path"')` → `"path"`. Round-trips correctly. Remove `stringRef` from `src/dag/types.ts`.

## Action Changes

### Pattern

```typescript
export interface XxxParams {
  kind: typeof NodeKind.Xxx;
  deps: { depA: DepName<DepAResult>; depB?: DepName<DepBResult> };
  // ... scalar fields ...
}

export function xxxAction(port: Port): ActionFunc<XxxParams, XxxResult> {
  return async (params, inputs) => {
    // inputs.depA: DepAResult (parsed by framework)
    // inputs.depB: DepBResult | undefined (optional dep)
    return result;  // framework JSON.stringifies
  };
}

export function addXxxNode(graph: Graph, ..., port: Port): NodeRef<XxxResult> {
  return addNode(graph, `xxx:${id}`, "xxx-v1", {
    kind: NodeKind.Xxx, ...,
    deps: { depA: dep(depARef) },  // compile error if depARef is wrong type
  } satisfies XxxParams, xxxAction(port));
}
```

### Transcribe example

```typescript
export interface TranscribeParams {
  kind: typeof NodeKind.Transcribe;
  videoId: string;
  outputDir: string;
  deps: { download: DepName<DownloadResult> };
}

export function transcribeAction(whisper: Transcriber): ActionFunc<TranscribeParams, TranscribeResult> {
  return async (params, inputs) => {
    const dir = toVideoDir(params.outputDir, params.videoId);
    return whisper.transcribe(inputs.download.audio, dir);
  };
}

export function addTranscribeNode(
  graph: Graph, videoId: string, download: NodeRef<DownloadResult>,
  whisper: Transcriber, outputDir: string,
): NodeRef<TranscribeResult> {
  return addNode(graph, `transcribe:${videoId}`, "whisper-v1,model=medium", {
    kind: NodeKind.Transcribe, videoId, outputDir,
    deps: { download: dep(download) },
  } satisfies TranscribeParams, transcribeAction(whisper));
}
```

### Rss-entry example (optional deps)

```typescript
export interface RssEntryParams {
  kind: typeof NodeKind.RssEntry;
  videoId: string;
  outputDir: string;
  deps: {
    download: DepName<DownloadResult>;
    transcribe: DepName<TranscribeResult>;
    thumbnail: DepName<string>;
    chapters: DepName<Chapter[]>;
    summary?: DepName<string>;
  };
}

export function rssEntryAction(fs: FileSystem): ActionFunc<RssEntryParams, EpisodeOutput> {
  return async (params, inputs) => {
    // inputs.download: DownloadResult
    // inputs.thumbnail: string (path)
    // inputs.chapters: Chapter[]
    // inputs.summary: string | undefined
    const description = inputs.summary
      ?? (await fs.readJson<YtDlpInfo>(inputs.download.info)).description
      ?? "";
    // ... episode assembly, returns EpisodeOutput ...
  };
}
```

### All actions

| Module        | Factory                      | Result type        | Params `deps`                                            |
| ------------- | ---------------------------- | ------------------ | -------------------------------------------------------- |
| download      | `downloadAction(ytdlp)`      | `DownloadResult`   | (none)                                                   |
| transcribe    | `transcribeAction(whisper)`   | `TranscribeResult` | `{ download: DepName<DownloadResult> }`                  |
| thumbnail     | `thumbnailAction(ffmpeg)`     | `string`           | `{ download: DepName<DownloadResult> }`                  |
| chapters      | `chaptersAction(fs, claude)`  | `Chapter[]`        | `{ download: DepName<DownloadResult>, transcribe: DepName<TranscribeResult> }` |
| summary       | `summaryAction(fs, claude)`   | `string`           | `{ download: DepName<DownloadResult>, transcribe: DepName<TranscribeResult> }` |
| rss-entry     | `rssEntryAction(fs)`          | `EpisodeOutput`    | `{ download: DepName<DownloadResult>, transcribe: DepName<TranscribeResult>, thumbnail: DepName<string>, chapters: DepName<Chapter[]>, summary?: DepName<string> }` |
| artwork       | `channelAvatarAction(ytdlp)`  | `string`           | (none)                                                   |
| artwork       | `artworkAction(ffmpeg)`       | `ArtworkOutput`    | `{ channel_avatar: DepName<string> }`                    |

## Type Safety Summary

`DepName<T>` does triple duty:

1. **Wiring safety** — `dep(transcribeRef)` is not assignable to `DepName<DownloadResult>`, catching miswired deps at the `addXxxNode` call site
2. **Input type inference** — `InputsFor` extracts `T` from `DepName<T>`, so actions receive typed, parsed inputs
3. **Serialization contract** — the brand documents what type the dep produces, even though at runtime it's just a string node name

No parse safety regression vs the current `NodeRef<T>.parse()` — `InputsFor<P>` gives typed results via branded phantom types + framework deserialization.

## Discriminated Params Union (future)

### `src/pipeline/actions/params.ts`

A union of all params types enables exhaustive dispatch for the remote runner. Build this when the remote runner is implemented, not before.

```typescript
export type ActionParams =
  | DownloadParams
  | TranscribeParams
  | ThumbnailParams
  | ChaptersParams
  | SummaryParams
  | RssEntryParams
  | ChannelAvatarParams
  | ArtworkParams;

function resolveFactory(params: ActionParams, ports: Ports): ActionFunc<BaseParams, unknown> {
  switch (params.kind) {
    case NodeKind.Download:      return downloadAction(ports.ytdlp);
    case NodeKind.Transcribe:    return transcribeAction(ports.whisper);
    case NodeKind.Thumbnail:     return thumbnailAction(ports.ffmpeg);
    case NodeKind.Chapters:      return chaptersAction(ports.fs, ports.claude);
    case NodeKind.Summary:       return summaryAction(ports.fs, ports.claude);
    case NodeKind.RssEntry:      return rssEntryAction(ports.fs);
    case NodeKind.ChannelAvatar: return channelAvatarAction(ports.ytdlp);
    case NodeKind.Artwork:       return artworkAction(ports.ffmpeg);
  }
}
```

TypeScript enforces all cases are handled. Adding a new action kind without updating the switch is a compile error.

## File Summary

| File                        | Change                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------- |
| `src/dag/types.ts`          | Add `DepName<T>`, `dep()`. `InputsFor` extracts branded types. `ActionFunc<P, R>` gains result type. `BaseParams.deps` uses `DepName`. Remove `stringRef`. |
| `src/dag/graph.ts`          | `addNode` wraps action with serde, returns `NodeRef<R>`. Add `parseInputs`. Simplify `localRunner`. |
| `src/pipeline/actions/*.ts` | Deps use `DepName<T>`, wiring uses `dep()`. Actions return typed `R`. `addXxxNode` returns `addNode(...)` directly. |
