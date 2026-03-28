# Plan A: Action Registry

## Problem Statement

dagraph couples action implementations (closures) to the graph via `RunnableNode`. The `action` field is a closure:

```ts
// packages/dagraph/src/graph/types.ts
action: (rawInputs: Record<string, Outputs>, outputDir: string) => Promise<Outputs>;
```

This closure captures `Ports`, config, and parameter-to-input resolution logic (wired in `addNode` at `packages/dagraph/src/graph/add-node.ts`). Closures cannot cross serialization boundaries. This forces the Temporal activity side (`src/cli/commands/serve/activities.ts`) to call `buildVideoGraph()` -- rebuilding the entire graph with all its closures -- just to look up one node by name and call `processNode` on it. The graph rebuild is pure waste: it exists only to recover the closure.

A secondary symptom: task routing metadata (`TEMPORAL_TASK_CONFIG` at `src/cli/commands/serve/task-config.ts`) is a parallel mapping from `NodeKind` to Temporal `ActivityOptions`. This duplicates the `kind` key that already exists on nodes, but lives in a completely separate file with no structural connection to the actions it describes.

## Proposed Solution

Decouple action implementations from the graph. Introduce a registry where actions are registered by their `kind` key. The graph stores only serializable descriptors (the existing `Node` type). Both local and distributed execution resolve actions from the registry at execution time.

## 1. The Registry API

### Core Type

```ts
// packages/dagraph/src/registry.ts

export interface ActionRegistration<P extends BaseParams = BaseParams, R extends Outputs = Outputs> {
  actionFactory: (config: string) => ActionFunc<P, R>;
  taskConfig?: TaskConfig;
}

export interface TaskConfig {
  taskQueue?: string;
  startToCloseTimeout?: string;
  scheduleToCloseTimeout?: string;
  retry?: {
    maximumAttempts?: number;
    backoffCoefficient?: number;
    maximumInterval?: string;
  };
}

export class ActionRegistry {
  private actions = new Map<string, ActionRegistration>();

  register<P extends BaseParams, R extends Outputs>(
    kind: string,
    registration: ActionRegistration<P, R>,
  ): void;

  resolve(kind: string): ActionRegistration;
  has(kind: string): boolean;
  taskConfigFor(kind: string): TaskConfig | undefined;
}
```

### How Actions Are Registered

Today, `defineAction` returns an `Action` object with `addNode` and `createAction` methods. `Action.addNode` wires a closure into the graph.

With the registry, `addNode` registers the resolved action into a registry instead of embedding it as a closure. The `Graph` no longer stores `RunnableNode` internally -- it stores `Node` (the serializable descriptor). The registry, passed alongside the graph, holds the closures.

Revised `Action.addNode`:

```ts
export interface Action<Ctx, P extends BaseParams, R extends Outputs> {
  addNode: (graph: Graph, registry: ActionRegistry, ctx: Ctx, params: P) => NodeRef<R>;
  createAction: (ctx: Ctx) => ActionFunc<P, R>;
}
```

### What Happens to `RunnableNode`

`RunnableNode` is removed from dagraph's public API. The `Graph` class changes from `Map<string, RunnableNode>` to `Map<string, Node>` internally.

`processNode` still needs the action closure and params for input resolution. These now come from the registry at call time. Two options:

**Option A: Registry stores the already-wrapped closure.** The registry is keyed by **node name** (not kind) since params differ per node. Minimal diff but means the registry is per-graph-instance.

**Option B: Node stores params, registry stores the ActionFunc.** The registry stores only the `ActionFunc<P, R>` keyed by `kind`. At execution time, `processNode` calls `resolveInputs(params, rawInputs)` then `action(params, inputs, outputDir)`.

**Recommendation: Option B.** It separates concerns properly: the registry is keyed by `kind` (one entry per action type), the graph stores per-node params. `Node` gains a `params: BaseParams` field (which is serializable):

```ts
export interface Node {
  name: string;
  kind: string;
  deps: string[];
  config: string;
  concurrencyGroup?: string;
  params: BaseParams;
}
```

`describe()` becomes trivial since everything is already serializable.

## 2. Local Execution Changes

Current flow in `execute()`:

1. Get `RunnableNode` map from `graph.getNodes()`
2. For each ready node, call `processNode(node, ...)` where `node` has the `action` closure

New flow:

```ts
export async function execute(
  graph: Graph,
  registry: ActionRegistry,
  ctx: ExecutionContext,
  opts?: ExecuteOptions,
): Promise<ExecResult[]> {
  const nodes = graph.getNodes();
  validateNoCycles(nodes);
  const run: RunNode = (desc, depContentHashes, depOutputs) => {
    const { actionFactory } = registry.resolve(desc.kind);
    const action = actionFactory(desc.config);
    return processNode(desc, action, depContentHashes, depOutputs, ctx, { force });
  };
  return orchestrate(nodes.values(), run, scheduler, opts?.onEvent);
}
```

`processNode` changes signature from taking `RunnableNode` to taking `Node` + `ActionFunc`:

```ts
export async function processNode(
  node: Node,
  action: ActionFunc<BaseParams, Outputs>,
  depContentHashes: Map<string, string>,
  depOutputs: Record<string, Outputs>,
  ctx: ExecutionContext,
  opts?: { force?: boolean },
): Promise<ProcessNodeResult>
```

## 3. Temporal Execution Changes

### Current Pain

In `activities.ts`, the `runVideoNode` activity does:

```ts
const graph = buildVideoGraph(video, ports, config);   // rebuild entire graph
const node = graph.getNodes().get(input.nodeName)!;     // find one node
return processNode(node, ...);                           // run it
```

The graph rebuild exists solely to recover the closure on `RunnableNode.action`.

### New Activity Implementation

With the registry, the activity side creates a registry once at worker startup:

```ts
export function createActivities(ports: Ports, configResolver: ConfigResolver = getConfig) {
  const registry = createPipelineRegistry(ports);

  async function runVideoNode(input: VideoNodeInput): Promise<ProcessNodeResult> {
    const { executionCtx } = defaultResolve(ports, configResolver, input.channelName);
    const { actionFactory } = registry.resolve(input.kind);
    const action = actionFactory(input.config);
    const node: Node = {
      name: input.nodeName,
      kind: input.kind,
      deps: Object.keys(input.depContentHashes),
      config: input.config,
      params: input.params,
    };
    return processNode(node, action, new Map(Object.entries(input.depContentHashes)), input.depOutputs, executionCtx);
  }
}
```

The `createPipelineRegistry` function registers all action kinds once:

```ts
export function createPipelineRegistry(ports: Ports): ActionRegistry {
  const registry = new ActionRegistry();
  registry.register(NodeKind.Download, {
    actionFactory: (config) => download.createAction(ports),
    taskConfig: { taskQueue: TASK_QUEUES.default, startToCloseTimeout: "30m", ... },
  });
  registry.register(NodeKind.Transcribe, { ... });
  return registry;
}
```

**What gets eliminated:**
- `buildVideoGraph()` call in `runVideoNode` -- the entire graph rebuild is gone
- The per-activity kind-dispatch in workflows simplifies
- `TEMPORAL_TASK_CONFIG` can be co-located with registrations

### Workflow Side Changes

With the registry carrying `taskConfig`, the workflow reads routing from the descriptors:

```ts
const run: RunNode = async (desc, depContentHashes, depOutputs) => {
  const taskConfig = registry.taskConfigFor(desc.kind) ?? defaultTaskConfig;
  const acts = proxyActivities<Activities>(taskConfig);
  return acts.runNode({
    nodeName: desc.name,
    kind: desc.kind,
    config: desc.config,
    params: desc.params,
    depContentHashes: Object.fromEntries(depContentHashes),
    depOutputs,
  });
};
```

This collapses the pattern of one activity per `VideoNodeKind` (all pointing to the same `runVideoNode`) into a single `runNode` activity.

## 4. Config-Dependent Actions (Factory Pattern)

Actions like `chapters` and `summary` are factory functions: `chapters(chapterPrompt)` returns a different `Action` based on the prompt config. With the registry keyed by `kind`, there is only one entry for `NodeKind.Chapters`.

**Solution:** The registry stores the action factory `(config: string) => ActionFunc`, not a pre-resolved `ActionFunc`. At execution time, the config is deserialized from the node's `config` field:

```ts
const { actionFactory } = registry.resolve(node.kind);
const action = actionFactory(node.config);
```

Each factory knows its own config format. The factory for `download` ignores the config string; the factory for `chapters` parses it as JSON.

## 5. Risks and Trade-offs

### Registration Ordering

Actions must be registered before execution begins. If a kind is used in the graph but not registered, `registry.resolve(kind)` throws at runtime.

**Mitigation:** Add a `validate(graph, registry)` function that checks all node kinds have registry entries. Call at the start of `execute()`.

### Type Safety

The registry erases `P` and `R` type parameters. **This is acceptable** because type safety is enforced at graph-build time (where typed `Action.addNode` is called), not at execution time (where the executor works with `Outputs`).

### Testability

The registry improves testability: unit tests can register mock actions for specific kinds without building real graphs. `processNode` can be tested with a plain `Node` + a stub `ActionFunc`.

### API Surface Change

This is a breaking change: `execute()` gains a `registry` parameter, `processNode()` gains an `action` parameter, `RunnableNode` is removed. Since dagraph is an internal package with few consumers, this is manageable.

## 6. Steel-Manning

The fundamental insight is that a DAG execution engine has two distinct concerns:

1. **What to execute and in what order** -- graph topology, dependency edges, node identity
2. **How to execute each node** -- action implementation, I/O, side effects

These have different serialization requirements. The graph must cross process boundaries. The actions are process-local. The current design conflates these by putting both on `RunnableNode`. The registry cleanly separates them via the shared `kind` key.

**Precedent:**
- **Redux:** Actions are plain objects with a `type` field. Reducers are registered by type. Redux explicitly forbids functions in actions because they don't serialize.
- **Temporal's own pattern:** Activities are registered by name in a worker; workflows reference them by name via `proxyActivities`. The workflow never holds the activity function.
- **Bazel/Buck:** Build systems separate the action graph (targets with string labels) from implementations (rules registered by kind).

**What this unlocks:**
- **Graph-only analysis:** The graph is unconditionally serializable. `describe()` and `getNodes()` return the same thing.
- **Remote graph construction:** Workflows can construct graphs directly (they are just data).
- **Multi-worker action resolution:** Different workers register different action subsets. GPU worker registers `transcribe`; CPU worker registers `download`. The graph is the same everywhere; the registry varies by worker.

## 7. Implementation Sequence

### Phase 1: Introduce the Registry (dagraph internal)
1. Create `packages/dagraph/src/registry.ts` with `ActionRegistry`
2. Add `params: BaseParams` to the `Node` interface
3. Change `Graph` from `Map<string, RunnableNode>` to `Map<string, Node>`
4. Update `addNode` to accept a registry parameter
5. Update `processNode` to accept `Node` + `ActionFunc`
6. Update `execute()` to accept a registry
7. Export `ActionRegistry` from `index.ts`

### Phase 2: Migrate Application Code
8. Update `defineActionWithPorts` to produce registry-compatible registrations
9. Create `createPipelineRegistry(ports)` in the pipeline layer
10. Update `buildVideoGraph` / `buildPipelineGraph` to accept a registry
11. Update local `execute()` call sites
12. Move `TEMPORAL_TASK_CONFIG` entries into action registrations

### Phase 3: Simplify Temporal Integration
13. Collapse `runVideoNode` to resolve from registry instead of rebuilding graph
14. Remove `buildVideoGraph` call from activities
15. Simplify workflow dispatch to a single `runNode` activity
16. Pass `params` and `config` through `VideoNodeInput`
17. Delete `task-config.ts`

### Phase 4: Cleanup
18. Remove `RunnableNode` from dagraph exports
19. Remove `describe()` from `Graph` (or alias to `getNodes()`)
20. Update all tests

## Critical Files

| File | Change |
|------|--------|
| `packages/dagraph/src/registry.ts` | **New.** Registry types and implementation. |
| `packages/dagraph/src/graph/types.ts` | Node gains `params`, RunnableNode removed. |
| `packages/dagraph/src/graph/graph.ts` | Internal storage changes to `Map<string, Node>`. |
| `packages/dagraph/src/graph/add-node.ts` | Registers action in registry instead of embedding closure. |
| `packages/dagraph/src/process-node.ts` | Accepts `Node` + `ActionFunc` instead of `RunnableNode`. |
| `packages/dagraph/src/execute.ts` | Accepts registry, resolves actions from it. |
| `src/pipeline/actions/define-action.ts` | Updated to work with registry. |
| `src/cli/commands/serve/activities.ts` | Graph rebuild eliminated, resolves from registry. |
| `src/cli/commands/serve/workflows.ts` | Simplified dispatch via registry task config. |
| `src/cli/commands/serve/task-config.ts` | **Deleted.** Merged into action registrations. |
