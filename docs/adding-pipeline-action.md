# Adding a pipeline action

This guide walks through adding a new node to the pipeline. Read [architecture.md](architecture.md) first — especially the "Anatomy of an action" section — to understand why things are structured the way they are.

We'll use a concrete example: adding a hypothetical `normalize` action that runs loudness normalization on the downloaded audio before it reaches `embedChapters`.

## 1. Add a NodeKind variant

In `src/pipeline/actions/define-action.ts`, add to `VideoNodeKind` (or `ChannelNodeKind` if it's a channel-level singleton):

```typescript
export enum VideoNodeKind {
  // ...existing...
  Normalize = "normalize",
}
```

This string becomes part of the node's name in the DAG and shows up in logs, progress bars, and cache directories.

## 2. Create the action file

Create `src/pipeline/actions/normalize.ts`:

```typescript
import type { NodeRefOf } from "@podpiper/dagraph";
import { NodeKind, defineActionWithPorts } from "./define-action";
import type { download } from "./download";

export interface NormalizeParams {
  kind: typeof NodeKind.Normalize;
  videoId: string;
  deps: { download: NodeRefOf<download> };
}

export const normalize = defineActionWithPorts<NormalizeParams, string>({
  config: "loudnorm-v1,target=-16LUFS",
  action: (ports) => async (_params, inputs, outputDir) => {
    const outputPath = `${outputDir}/audio-normalized.mp3`;
    await ports.ffmpeg.normalize(inputs.download.audio, outputPath);
    return outputPath;
  },
});
export type normalize = typeof normalize;
```

Key decisions being made here:

**Params and deps.** The `deps` record declares what this action reads. `NodeRefOf<download>` means "a reference to whatever `download` returns" — which is `{ audio, info, thumb }`. When the action runs, `inputs.download.audio` is the resolved file path. The compiler won't let you read `inputs.download.audio` without declaring the dependency, and it won't let you declare a dependency with the wrong type.

**Config string.** `"loudnorm-v1,target=-16LUFS"` encodes the parameters that affect output. This becomes part of the action key hash:

```
actionKey = SHA256(nodeName + config + sort(depContentHashes))
```

Change the target loudness and all cached normalizations re-execute. The `v1` prefix is a manual lever — bump it when you change the action's internal logic without changing the config parameters.

**Output.** The action returns a file path (`string`). dagraph hashes this file to compute a content hash, which flows into downstream action keys. If normalization produces an identical file (e.g., the audio was already at -16 LUFS), the content hash doesn't change and downstream nodes stay cached.

**CAS directory.** The action writes to `outputDir`, which is a content-addressed storage directory managed by dagraph (`{casBaseDir}/{actionKey}/`). Never construct output paths from config or video IDs — the executor manages the directory.

## 3. Wire it into the graph

In `src/pipeline/graph-builder.ts`, add the node and thread its ref to downstream consumers:

```typescript
import { normalize } from "./actions/normalize";

// Inside addVideoSubgraph:
const normalizeRef = normalize.addNode(scope, ports, {
  kind: NodeKind.Normalize,
  videoId: video.id,
  deps: { download: downloadRef },
});
```

Then update downstream nodes that should read the normalized audio instead of the raw download. For example, `embedChapters` would now depend on `normalize`:

```typescript
const embedChaptersRef = embedChapters.addNode(scope, ports, {
  kind: NodeKind.EmbedChapters,
  videoId: video.id,
  deps: { download: normalizeRef, chapters: chaptersRef },
  //                ^^^^^^^^^^^^
  //  This would require updating EmbedChaptersParams.deps
  //  to accept the normalize output type
});
```

The compiler enforces this. If `embedChapters` expects `NodeRefOf<download>` but you pass `NodeRefOf<normalize>`, you get a type error. You'll need to update the downstream params interface to accept the new dependency shape — the compiler tells you exactly what to fix.

## 4. Handle optional actions

If the action should only run for some channels, make it conditional in the graph builder:

```typescript
const normalizeRef = config.normalizeLoudness
  ? normalize.addNode(scope, ports, { kind: NodeKind.Normalize, videoId, deps: { download: downloadRef } })
  : undefined;
```

Downstream nodes can accept the optionality via `?` in their deps:

```typescript
deps: { download: NodeRefOf<download>; normalize?: NodeRefOf<normalize> }
```

The action then checks `inputs.normalize` at runtime. This is the same pattern `chapters.ts` uses with its optional `transcribe` dependency.

## 5. Factory pattern for channel-configurable actions

If the action's behavior varies per channel (like `chapters` varies by prompt), use a factory:

```typescript
interface NormalizeConfig {
  version: 1;
  targetLufs: number;
}

export const normalize = (targetLufs: number) =>
  defineActionWithPorts<NormalizeParams, string, NormalizeConfig>({
    config: { version: 1, targetLufs },
    action: (ports, config) => async (_params, inputs, outputDir) => {
      const outputPath = `${outputDir}/audio-normalized.mp3`;
      await ports.ffmpeg.normalize(inputs.download.audio, outputPath, config.targetLufs);
      return outputPath;
    },
  });
```

The config object is deterministically serialized (sorted keys) and hashed. Changing `targetLufs` in the channel config automatically invalidates all cached normalizations for that channel. The `version` field is for when you change the normalization logic itself.

Wire it in the graph builder as:

```typescript
normalize(config.targetLufs).addNode(scope, ports, { ... })
```

## 6. Add a concurrency group (if needed)

If the action is resource-constrained (GPU, rate-limited API), declare a concurrency group:

```typescript
export const normalize = defineActionWithPorts<NormalizeParams, string>({
  config: "loudnorm-v1,target=-16LUFS",
  concurrencyGroup: "ffmpeg",
  action: (ports) => async (_params, inputs, outputDir) => { ... },
});
```

The throttled scheduler enforces per-group limits set at execution time (e.g., `{ ffmpeg: 2, whisper: 1 }`). Nodes without a concurrency group are only subject to the global parallelism limit.

## 7. Temporal support

If the pipeline runs on Temporal (`serve` command), add the new node kind to the task config in `src/cli/commands/serve/task-config.ts`:

```typescript
[NodeKind.Normalize]: {
  taskQueue: "default",
  startToCloseTimeout: "10m",
  retry: { maximumAttempts: 3 },
},
```

This maps the node kind to a Temporal task queue, timeout, and retry policy. No other changes needed — the activity runner dispatches based on node kind automatically.

## Checklist

- [ ] `NodeKind` variant added
- [ ] Action file created with params, config, and action function
- [ ] Graph builder updated — node added, downstream deps threaded
- [ ] Temporal task config updated (if using `serve`)
- [ ] Config string/object encodes everything that affects output
