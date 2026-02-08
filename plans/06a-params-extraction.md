# 06a — Extract Serializable Params from Action Closures

## What

Split action closures so ports (non-serializable) are bound at factory time and params (serializable) arrive at call time. Add an `addNode` helper that derives `deps` and `kind` from params — single source of truth.

## Why

A remote runner needs to deserialize params and invoke the action without the original closure. Currently, ports and params are mixed in closures with no serialization boundary. Making params explicit enables distribution: serialize `node.params`, send to a worker, look up the factory by `kind`, invoke.

## Core Types

### `src/dag/types.ts`

```typescript
type InputsFor<P> = P extends { deps: infer D }
  ? { [K in keyof D]: undefined extends D[K] ? string | undefined : string }
  : {};

type ActionFunc<P extends BaseParams = BaseParams> =
  (params: P, inputs: InputsFor<P>) => Promise<string>;

interface BaseParams {
  kind: string;
  deps?: Record<string, string | undefined>;
}

interface Node {
  name: string;
  kind: string;
  deps: string[];
  config: string;
  params: BaseParams;
  action: ActionFunc;
}
```

- `ActionFunc<P>` is the typed form used by factories. The default `BaseParams` gives the type-erased form stored on `Node`. Typed factories return `ActionFunc<TranscribeParams>` which is assignable to `ActionFunc` — no explicit cast.
- `InputsFor<P>` reuses the deps key names. If `deps: { download: string; summary?: string }`, the action receives `inputs: { download: string; summary?: string }`. Values are strings in both cases (dep names in params, dep results in inputs) — same type, different semantics. Optional deps stay optional.
- `NodeRef<T>` is unchanged.

## `addNode` Helper

### `src/dag/graph.ts`

```typescript
function depsFromParams(params: BaseParams): string[] {
  if (!params.deps) return [];
  return Object.values(params.deps).filter((v): v is string => v != null);
}

function rekeyByRole(
  params: BaseParams,
  rawInputs: Record<string, string>,
): Record<string, string> {
  if (!params.deps) return {};
  return Object.fromEntries(
    Object.entries(params.deps)
      .filter(([, v]) => v != null)
      .map(([role, depName]) => [role, rawInputs[depName!]!]),
  );
}

export function addNode<P extends BaseParams>(
  graph: Graph,
  name: string,
  config: string,
  params: P,
  action: ActionFunc<P>,
): void {
  graph.add({ name, kind: params.kind, deps: depsFromParams(params), config, params, action });
}

export const localRunner: NodeRunner = (node, rawInputs) =>
  node.action(node.params, rekeyByRole(node.params, rawInputs));
```

`kind` and `deps` are derived from params. No redundant declarations, no divergence possible.

The graph engine stores results keyed by node name (`"download:vid_abc": "<result>"`). `rekeyByRole` translates to role names (`"download": "<result>"`). The `!` is safe by construction — the graph engine guarantees dep results exist before running a node.

## Action Pattern

Each module exports a params interface, a factory, and a thin `addXxxNode` wrapper.

```typescript
export interface XxxParams {
  kind: typeof NodeKind.Xxx;
  deps: { depA: string; depB?: string };
  // ... scalar fields ...
}

export function xxxAction(port: Port): ActionFunc<XxxParams> {
  return async (params, inputs) => {
    const depA: DepAResult = JSON.parse(inputs.depA);
    return JSON.stringify(result);
  };
}

export function addXxxNode(graph: Graph, ..., port: Port): NodeRef<T> {
  const name = `xxx:${id}`;
  addNode(graph, name, "xxx-v1", {
    kind: NodeKind.Xxx, ...,
    deps: { depA: depARef.name },
  } satisfies XxxParams, xxxAction(port));
  return jsonRef<T>(name);
}
```

### Full example: `transcribe.ts`

**Before:**

```typescript
export function addTranscribeNode(
  graph: Graph, videoId: string, download: NodeRef<DownloadResult>,
  whisper: Transcriber, outputDir: string,
): NodeRef<TranscribeResult> {
  const name = `transcribe:${videoId}`;
  const dir = toVideoDir(outputDir, videoId);
  graph.add({
    name, kind: NodeKind.Transcribe, deps: [download.name],
    config: "whisper-v1,model=medium",
    action: async (inputs) => {
      const dl = download.parse(inputs[download.name]!);
      return JSON.stringify(await whisper.transcribe(dl.audio, dir));
    },
  });
  return jsonRef<TranscribeResult>(name);
}
```

**After:**

```typescript
export interface TranscribeParams {
  kind: typeof NodeKind.Transcribe;
  videoId: string;
  outputDir: string;
  deps: { download: string };
}

export function transcribeAction(whisper: Transcriber): ActionFunc<TranscribeParams> {
  return async (params, inputs) => {
    const dl: DownloadResult = JSON.parse(inputs.download);
    const dir = toVideoDir(params.outputDir, params.videoId);
    return JSON.stringify(await whisper.transcribe(dl.audio, dir));
  };
}

export function addTranscribeNode(
  graph: Graph, videoId: string, download: NodeRef<DownloadResult>,
  whisper: Transcriber, outputDir: string,
): NodeRef<TranscribeResult> {
  const name = `transcribe:${videoId}`;
  addNode(graph, name, "whisper-v1,model=medium", {
    kind: NodeKind.Transcribe, videoId, outputDir,
    deps: { download: download.name },
  } satisfies TranscribeParams, transcribeAction(whisper));
  return jsonRef<TranscribeResult>(name);
}
```

## All Actions

| Module        | Factory                      | Params `deps`                                            |
| ------------- | ---------------------------- | -------------------------------------------------------- |
| download      | `downloadAction(ytdlp)`      | (none)                                                   |
| transcribe    | `transcribeAction(whisper)`   | `{ download }`                                           |
| thumbnail     | `thumbnailAction(ffmpeg)`     | `{ download }`                                           |
| chapters      | `chaptersAction(fs, claude)`  | `{ download, transcribe }`                               |
| summary       | `summaryAction(fs, claude)`   | `{ download, transcribe }`                               |
| rss-entry     | `rssEntryAction(fs)`          | `{ download, transcribe, thumbnail, chapters, summary? }` |
| artwork       | `channelAvatarAction(ytdlp)`  | (none)                                                   |
| artwork       | `artworkAction(ffmpeg)`       | `{ channel_avatar }`                                     |

## Unchanged

- `computeHash` — still hashes `name + config + dep hashes`.
- `graph-builder.ts` — `addXxxNode` signatures unchanged, call sites unchanged.
- `NodeRef<T>`, `jsonRef`, `stringRef` — unchanged.

## File Summary

| File                        | Change                                                                            |
| --------------------------- | --------------------------------------------------------------------------------- |
| `src/dag/types.ts`          | Add `InputsFor`, `BaseParams`, generic `ActionFunc<P>`. Add `params` to `Node`.   |
| `src/dag/graph.ts`          | Add `addNode`, `depsFromParams`, `rekeyByRole`. Update `localRunner`.             |
| `src/pipeline/actions/*.ts` | Add `*Params` interfaces and `*Action` factories. Simplify `addXxxNode` via `addNode`. |
