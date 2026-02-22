# Hatchet Integration via Graph-to-Workflow Adapter

## Context

The DAG engine's `NodeRunner` abstraction operates at the wrong level for orchestration engine integration — it's a leaf-level hook called by the engine's own scheduler, while Hatchet IS a scheduler. The fix: make `Graph` a pure data structure (no execution logic) and write a generic adapter that translates a Graph's topology into a Hatchet workflow with per-task visibility in the Hatchet UI.

The `graph` CLI command already proves the topology is knowable a priori — it builds a graph with dummy videos and walks `getNodes()` for Mermaid visualization. The same trick works for Hatchet registration.

### Build system cross-reference (Bazel / Buck2)

Our architecture mirrors established patterns from Bazel and Buck2:

| Our concept            | Our name           | Bazel equivalent          | Rationale                                                                                       |
| ---------------------- | ------------------ | ------------------------- | ----------------------------------------------------------------------------------------------- |
| Action graph           | `Graph`            | ActionGraph               | Package is `dag`; `Graph` is clear in context                                                   |
| Unit of work           | `Node`             | Action / Spawn            | `Node` = graph vertex containing an action. We already use "action" in `ActionDef`/`ActionFunc` |
| Execution orchestrator | `execute()`        | `ActionExecutionFunction` | Standalone function that handles topological traversal, caching, parallelism                    |
| Execution strategy     | `NodeRunner`       | `SpawnStrategy`           | Pluggable HOW-to-execute. Function type (vs Bazel's interface) follows "functions over objects" |
| Execution context      | `ExecutionContext` | `ActionExecutionContext`  | Noun-noun compound: "execution context", not "execute context"                                  |
| Local strategy         | `localRunner`      | LocalSpawnRunner          | Default strategy: just call `node.action(inputs)`                                               |

Key architectural alignments:

- **Graph as pure data**: Bazel's ActionGraph is immutable declarations — actions don't know how to execute themselves. Our Part 1 achieves this.
- **Caching separate from strategy**: Bazel checks action cache in `ActionExecutionFunction` before strategy selection. Our `execute()` checks cache before calling `NodeRunner`. Same layering.
- **Strategy interchangeability**: Bazel requires different strategies to produce identical outputs. Our `localRunner` and Hatchet runner produce the same `Outputs` — cache entries are interchangeable.

### Design decisions made

| Decision                             | Choice                                       | Rationale                                                                                                                                                                                                             |
| ------------------------------------ | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where Hatchet task config lives      | Separate `TASK_CONFIG` map in serve module   | dag package stays orchestrator-agnostic                                                                                                                                                                               |
| How per-video tasks call actions     | Build full video graph + custom `NodeRunner` | Build the per-video graph, call `execute()` with a runner that only does real work for the target node. Ancestors resolve from Hatchet, descendants are no-ops (cache hit or throw). `execute()` handles all caching. |
| How channel-level tasks call actions | `createAction` on `ActionDef`                | Channel avatar/artwork are singletons with static params — direct dispatch via exposed factory                                                                                                                        |
| Topology source                      | Declarative `videoPipelineSteps()`           | Single source of truth — both `addVideoSubgraph` and Hatchet adapter consume it                                                                                                                                       |
| Caching                              | Handled by `execute()`                       | Same cache keys as local executor — cache entries interchangeable between `sync` CLI and Hatchet. No separate `runWithCache` needed.                                                                                  |
| NodeRunner role                      | Hatchet integration point                    | Custom runner resolves ancestor outputs from Hatchet, runs target node locally. This is the pluggable execution strategy `NodeRunner` was designed for.                                                               |

## Part 1: Separate Graph from Execution

Remove `cache`, `hashFile`, and `execute()` from `Graph`. Extract execution into a standalone function.

### `packages/dag/src/graph.ts`

```typescript
// Graph becomes a pure data structure
export class Graph {
  private nodes = new Map<string, Node>();

  add(def: Node): void {
    /* unchanged */
  }
  getNodes(): ReadonlyMap<string, Node> {
    return this.nodes;
  }
  analyze(): AnalysisResult {
    /* unchanged */
  }
}

// localRunner stays here (it's a simple NodeRunner impl)
export const localRunner: NodeRunner = (node, rawInputs) => node.action(rawInputs);
```

### New: `packages/dag/src/execute.ts`

Move execution logic from `Graph.execute` into a standalone function.

```typescript
export interface ExecutionContext {
  cache: Cache;
  hashFile: HashFileFn;
}

// Full DAG executor (moved from Graph.execute)
export async function execute(
  graph: Graph,
  ctx: ExecutionContext,
  runner: NodeRunner = localRunner,
  opts?: ExecuteOptions,
): Promise<ExecResult[]> {
  // identical logic to current Graph.execute, using ctx.cache and ctx.hashFile
}
```

### Consumer changes

**`src/pipeline/graph-builder.ts`** — remove `cache` parameter:

```typescript
// Before: buildPipelineGraph(cache, videos, ports, config)
// After:  buildPipelineGraph(videos, ports, config)
// Graph constructor: new Graph() instead of new Graph(cache, hashFile)
```

**`src/pipeline/execute.ts`** — use standalone `execute()`:

```typescript
import { execute } from "@podpiper/dag/execute";
import { localRunner } from "@podpiper/dag/graph";

export async function sync(
  graph: Graph,
  refs: PipelineRefs,
  fs: FileSystem,
  executionCtx: ExecutionContext,
  opts?: ExecuteOptions,
): Promise<SyncResult> {
  const results = await execute(graph, executionCtx, localRunner, opts);
  // ... rest unchanged
}
```

**`src/cli/commands/sync/sync.ts`** — construct `ExecutionContext`, pass to `sync()`:

```typescript
const { graph, refs } = buildPipelineGraph(videos, ports, config);
const executionCtx: ExecutionContext = { cache, hashFile: ports.fs.hashFile };
const syncResult = await sync(graph, refs, ports.fs, executionCtx, { ... });
```

**`src/cli/commands/graph/graph.ts`** — simplify (no more MemCache in buildPipelineGraph):

```typescript
const { graph } = buildPipelineGraph(videos, createStubPorts(), config);
```

## Part 2: `createAction` on ActionDef

Expose the raw action factory alongside `addNode`.

### `packages/dag/src/define-action.ts`

```typescript
export interface ActionDef<Ctx, P extends BaseParams, R extends Outputs> {
  addNode: (graph: Graph, ctx: Ctx, params: P) => NodeRef<R>;
  createAction: (ctx: Ctx) => ActionFunc<P, R>; // NEW
}

export function defineAction<Ctx, P extends BaseParams, R extends Outputs, C = string>(
  spec: ActionSpec<Ctx, P, R, C>,
): ActionDef<Ctx, P, R> {
  const configStr = typeof spec.config === "string" ? spec.config : stableStringify(spec.config);
  return {
    addNode: (graph, ctx, params) =>
      graphAddNode({
        graph,
        name: spec.name(params),
        config: configStr,
        params,
        action: spec.action(ctx, spec.config),
      }),
    createAction: (ctx) => spec.action(ctx, spec.config), // just expose it
  };
}
```

No changes needed to any action definition files — they all use `defineActionWithPorts` which calls `defineAction`.

## Part 3: Declarative Pipeline + Hatchet Workflow Adapter

### Declarative pipeline spec

Refactor `addVideoSubgraph` to be data-driven. `videoPipelineSteps()` is the single source of truth for the video pipeline topology — both the graph builder and the Hatchet adapter consume it.

```typescript
// src/pipeline/graph-builder.ts
export interface PipelineStep {
  kind: NodeKind;
  action: ActionDef<Ports, any, any>;
  depKinds: Record<string, NodeKind>;
}

export function videoPipelineSteps(config: Config): PipelineStep[] {
  return [
    { kind: NodeKind.Download, action: download, depKinds: {} },
    { kind: NodeKind.Transcribe, action: transcribe, depKinds: { download: NodeKind.Download } },
    { kind: NodeKind.Thumbnail, action: thumbnail, depKinds: { download: NodeKind.Download } },
    {
      kind: NodeKind.Chapters,
      action: chapters(config.chapterPrompt),
      depKinds: { download: NodeKind.Download, transcribe: NodeKind.Transcribe },
    },
    ...(config.summaryPrompt
      ? [
          {
            kind: NodeKind.Summary,
            action: summary(config.summaryPrompt),
            depKinds: { download: NodeKind.Download, transcribe: NodeKind.Transcribe },
          },
        ]
      : []),
    {
      kind: NodeKind.RssEntry,
      action: rssEntry,
      depKinds: {
        download: NodeKind.Download,
        transcribe: NodeKind.Transcribe,
        thumbnail: NodeKind.Thumbnail,
        chapters: NodeKind.Chapters,
        ...(config.summaryPrompt ? { summary: NodeKind.Summary } : {}),
      },
    },
  ];
}

// addVideoSubgraph becomes generic, driven by steps
function addVideoSubgraph(
  graph: Graph,
  video: VideoInfo,
  ports: Ports,
  config: Config,
  steps: PipelineStep[],
): NodeRef<RssEntryResult> {
  const refs = new Map<NodeKind, NodeRef>();
  for (const step of steps) {
    const deps = Object.fromEntries(
      Object.entries(step.depKinds).map(([role, kind]) => [role, refs.get(kind)]),
    );
    refs.set(
      step.kind,
      step.action.addNode(graph, ports, {
        kind: step.kind,
        videoId: video.id,
        outputDir: config.outputDir,
        deps,
      }),
    );
  }
  return refs.get(NodeKind.RssEntry)!;
}

// buildPipelineGraph uses steps internally
export function buildPipelineGraph(videos, ports, config) {
  const graph = new Graph();
  const steps = videoPipelineSteps(config);
  const entryRefs = videos.map((v) => addVideoSubgraph(graph, v, ports, config, steps));
  // ... channel artwork same as before
}
```

The `VideoActions` interface is removed — the steps structure replaces it.

### Task config

```typescript
// src/serve/task-config.ts
export interface TaskConfig {
  retries?: number;
  timeout?: string;
  concurrency?: { expression: string; maxRuns: number };
}

export const TASK_CONFIG: Record<string, TaskConfig> = {
  [NodeKind.Download]: {
    retries: 3,
    timeout: "10m",
    concurrency: { expression: "'yt-dlp'", maxRuns: 2 },
  },
  [NodeKind.Transcribe]: {
    retries: 2,
    timeout: "30m",
    concurrency: { expression: "'whisper'", maxRuns: 1 },
  },
  [NodeKind.Thumbnail]: { retries: 2, timeout: "1m" },
  [NodeKind.Chapters]: {
    retries: 5,
    timeout: "2m",
    concurrency: { expression: "'claude'", maxRuns: 3 },
  },
  [NodeKind.Summary]: {
    retries: 5,
    timeout: "2m",
    concurrency: { expression: "'claude'", maxRuns: 3 },
  },
  [NodeKind.RssEntry]: { retries: 1, timeout: "30s" },
};
```

### The adapter: `toHatchetVideoWorkflow`

Walks the pipeline steps to register Hatchet tasks with correct parent relationships. At trigger time, each task builds a fresh graph for the actual video and calls `execute()` with a custom `NodeRunner` that resolves ancestor outputs from Hatchet.

```typescript
// src/serve/adapter.ts
function toHatchetVideoWorkflow(
  hatchet: Hatchet,
  name: string,
  steps: PipelineStep[],
  ports: Ports,
  config: Config,
  executionCtx: ExecutionContext,
) {
  const workflow = hatchet.workflow<VideoInput>({ name });
  const taskRefs = new Map<string, HatchetTaskRef>();

  for (const step of steps) {
    const parents = Object.values(step.depKinds)
      .map((kind) => taskRefs.get(kind))
      .filter(Boolean);
    const taskConf = TASK_CONFIG[step.kind] ?? {};

    taskRefs.set(
      step.kind,
      workflow.task({
        name: step.kind,
        parents,
        retries: taskConf.retries,
        executionTimeout: taskConf.timeout,
        concurrency: taskConf.concurrency,
        fn: async (input: VideoInput, ctx) => {
          const video = { id: input.videoId, uploadDate: input.uploadDate, title: input.title };
          const { graph } = buildPipelineGraph([video], ports, config);
          const targetName = `${step.kind}:${input.videoId}`;

          // Custom NodeRunner: only do real work for the target node
          const runner: NodeRunner = (node, inputs) => {
            if (node.name === targetName) return node.action(inputs);
            const parentTask = taskRefs.get(node.kind);
            if (parentTask) return ctx.parentOutput(parentTask) as Promise<Outputs>;
            throw new Error(`skip: ${node.name}`);
          };

          const results = await execute(graph, executionCtx, runner);
          const result = results.find((r) => r.name === targetName)!;
          if (result.status === "fail") throw (result as any).error;
          return result.outputs;
        },
      }),
    );
  }

  return workflow;
}
```

### How this works

For a transcribe task with `input.videoId = "abc123"`:

1. `buildPipelineGraph([video], ports, config)` creates the full ~8-node video graph
2. `execute()` traverses in topological order:
   - **download:abc123** (ancestor): cache check → hit → done. If miss → runner resolves from `ctx.parentOutput(downloadTask)` → `execute()` caches it.
   - **transcribe:abc123** (target): cache check → hit → done. If miss → runner calls `node.action(inputs)` → transcribes audio → `execute()` caches result.
   - **thumbnail:abc123** (sibling): cache check → hit → done. If miss → runner resolves from Hatchet or throws → doesn't affect target result.
   - **chapters, summary, rss_entry** (downstream): same — cache hits are free, misses throw and are ignored.
3. Extract the target's result from the results array.

**NodeRunner IS the integration point**: the custom runner selectively delegates nodes to Hatchet or local execution. `execute()` handles all caching transparently.

**Cache compatibility**: identical cache keys between `sync` CLI and Hatchet because the same `computeHash` operates on the same node metadata from `buildPipelineGraph`.

## Part 4: Channel-Sync Workflow

Each channel gets a parent workflow. Channel-level nodes (channel_avatar, artwork) are hand-wired here since they're singleton tasks with no per-video parameterization.

```typescript
// src/serve/channel-workflow.ts
function registerChannelWorkflow(
  hatchet: Hatchet,
  channelName: string,
  config: Config,
  ports: Ports,
  executionCtx: ExecutionContext,
  videoPipeline: HatchetWorkflow<VideoInput>,
) {
  const workflow = hatchet.workflow<void>({
    name: `${channelName}-sync`,
    on: { cron: config.schedule ?? "0 8 * * *" },
  });

  const discover = workflow.task({
    name: "discover",
    fn: async () => {
      const allVideos = await discoverVideos(config.channelUrl, ports.ytdlp);
      const existing = await getExistingVideoIds(config, ports.storage);
      return { videos: allVideos.filter((v) => !existing.has(v.id)) };
    },
  });

  const processVideos = workflow.task({
    name: "process-videos",
    parents: [discover],
    fn: async (_, ctx) => {
      const { videos } = await ctx.parentOutput(discover);
      const results = await Promise.all(
        videos.map((v: VideoInfo) =>
          ctx.runChild(videoPipeline, { videoId: v.id, uploadDate: v.uploadDate, title: v.title }),
        ),
      );
      return { results };
    },
  });

  // Channel artwork (parallel with processVideos, both depend on discover)
  const avatarTask = workflow.task({
    name: "channel-avatar",
    parents: [discover],
    retries: 3,
    fn: async () => {
      const actionFn = channelAvatar.createAction(ports);
      const avatarDir = `${config.outputDir}/artwork`;
      return await actionFn(
        { kind: NodeKind.ChannelAvatar, channelUrl: config.channelUrl, avatarDir },
        {},
      );
    },
  });

  const artworkTask = workflow.task({
    name: "artwork",
    parents: [avatarTask],
    fn: async (_, ctx) => {
      const avatarPath = await ctx.parentOutput(avatarTask);
      const actionFn = artwork.createAction(ports);
      return await actionFn(
        {
          kind: NodeKind.Artwork,
          artworkPath: `${config.outputDir}/artwork.jpg`,
          outputDir: config.outputDir,
        },
        { channel_avatar: avatarPath as string },
      );
    },
  });

  workflow.task({
    name: "publish",
    parents: [processVideos, artworkTask],
    fn: async (_, ctx) => {
      const { results: childResults } = await ctx.parentOutput(processVideos);
      const artworkUploads = await ctx.parentOutput(artworkTask);

      // Collect episodes and uploads from child workflow results
      const uploads: UploadEntry[] = [];
      const episodes: Episode[] = [];
      for (const result of childResults) {
        const paths = result as RssEntryResult;
        episodes.push(await readJson(ports.fs, paths.episode));
        uploads.push(...(await readJson(ports.fs, paths.uploads)));
      }
      if (artworkUploads) {
        uploads.push(...(await readJson(ports.fs, artworkUploads as JsonPath<UploadEntry[]>)));
      }

      await publish({ uploads, episodes, results: [] }, config, ports.fs, ports.storage);
    },
  });

  return workflow;
}
```

## Part 5: Serve Command + Config Changes

### `src/config.ts` — export channels, add optional schedule

```typescript
export const channels: Record<string, ChannelDef> = {
  /* existing */
};

type ChannelDef = Omit<Config, "outputDir"> & { schedule?: string };
```

### `src/cli/commands/serve/serve.ts`

```typescript
export function registerServe(program: Command) {
  program
    .command("serve")
    .description("Run as a Hatchet worker with scheduled syncs")
    .option("-s, --slots <n>", "Max concurrent tasks", (v: string) => parseInt(v), 4)
    .action(async (opts: { slots: number }) => {
      const hatchet = Hatchet.init();
      const ports = createRealPorts({});
      const workflows = [];

      for (const [name, def] of Object.entries(channels)) {
        const config = getConfig(name);
        const cache = new LocalCache(/* load from disk */);
        const executionCtx: ExecutionContext = { cache, hashFile: ports.fs.hashFile };

        const steps = videoPipelineSteps(config);
        const videoPipeline = toHatchetVideoWorkflow(
          hatchet,
          `${name}-video`,
          steps,
          ports,
          config,
          executionCtx,
        );
        const channelWorkflow = registerChannelWorkflow(
          hatchet,
          name,
          config,
          ports,
          executionCtx,
          videoPipeline,
        );
        workflows.push(videoPipeline, channelWorkflow);
      }

      const worker = await hatchet.worker("podpiper", { workflows, slots: opts.slots });
      await worker.start();
    });
}
```

### `src/cli/cli.ts` — add `registerServe(program)`

## Files Changed Summary

| File                                | Change                                                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `packages/dag/src/graph.ts`         | Remove cache/hashFile from constructor, remove execute method                                                  |
| `packages/dag/src/execute.ts`       | **New**: standalone `execute()`                                                                                |
| `packages/dag/src/define-action.ts` | Add `createAction` to `ActionDef`                                                                              |
| `packages/dag/src/types.ts`         | Export `ExecutionContext` type                                                                                 |
| `src/pipeline/graph-builder.ts`     | Remove `cache` param, add `PipelineStep`/`videoPipelineSteps()`, refactor `addVideoSubgraph` to be data-driven |
| `src/pipeline/execute.ts`           | Use standalone `execute()`, accept `ExecutionContext`                                                          |
| `src/cli/commands/sync/sync.ts`     | Construct `ExecutionContext`, pass to `sync()`                                                                 |
| `src/cli/commands/graph/graph.ts`   | Remove `MemCache` from `buildPipelineGraph` call                                                               |
| `src/config.ts`                     | Export `channels`, add optional `schedule` to `ChannelDef`                                                     |
| `src/cli/cli.ts`                    | Register serve command                                                                                         |
| `src/serve/task-config.ts`          | **New**: `TASK_CONFIG`                                                                                         |
| `src/serve/adapter.ts`              | **New**: `toHatchetVideoWorkflow()`                                                                            |
| `src/serve/channel-workflow.ts`     | **New**: `registerChannelWorkflow()`                                                                           |
| `src/cli/commands/serve/serve.ts`   | **New**: serve CLI command                                                                                     |
| `package.json`                      | Add `@hatchet-dev/typescript-sdk` dependency                                                                   |
| Tests in `packages/dag/`            | Update `new Graph(cache, hashFile)` → `new Graph()`, pass `ExecutionContext` to `execute()`                    |

## Implementation Order

1. **Part 1**: Separate Graph from execution (pure refactor, all tests pass, sync/graph commands unchanged)
2. **Part 2**: Add `createAction` to ActionDef (additive, no behavior change)
3. **Part 3**: Declarative pipeline spec — refactor `graph-builder.ts` to be data-driven (`videoPipelineSteps` + generic `addVideoSubgraph`), then build Hatchet adapter consuming the same steps
4. **Parts 4-5**: Channel workflow + serve command (new files only)

## Verification

1. **After Part 1**: Run `bunx tsgo` (typecheck) + existing tests. Run `bun run src/cli.ts graph heidi` and `bun run src/cli.ts sync heidi -d` to verify no regression.
2. **After Part 2**: Run `bunx tsgo` — new `createAction` field should be inferred on all existing action definitions without changes to action files.
3. **After Parts 3-5**: Start Hatchet server locally (`hatchet server start`), export token, run `bun run src/cli.ts serve`. Verify workflows appear in Hatchet UI at localhost:8080. Trigger a sync manually and observe per-task execution.
