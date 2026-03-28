# Plan C: Pluggable Executor Strategy

## Problem Statement

dagraph has two execution modes that share core orchestration logic but diverge at the "how to run a node" boundary:

**Local mode** (`execute()` in `packages/dagraph/src/execute.ts`): Hardwires `processNode` as the `RunNode` callback, picks a scheduler, and calls `orchestrate()`. The caller provides an `ExecutionContext` (cache + fs + casBaseDir).

**Temporal mode** (`videoWorkflow` in `src/cli/commands/serve/workflows.ts`): Bypasses `execute()` entirely. Manually constructs a `RunNode` lambda that calls `proxyActivities` with per-kind `ActivityOptions` from `TEMPORAL_TASK_CONFIG`. Calls `orchestrate()` directly with `unboundedScheduler`. On the activity side, each activity rebuilds the full graph to recover the `RunnableNode` closure, then calls `processNode`.

The tension: both modes do the same thing (validate graph, pick scheduler, wire a RunNode, call orchestrate) but the Temporal path must manually replicate the wiring that `execute()` does internally. The seam between dagraph and Temporal is ad hoc -- Temporal reimplements the "execution strategy" that `execute()` bakes in.

## Proposed Solution

Extract "how and where to run a node" into a first-class `ExecutionStrategy` interface. `execute()` accepts a strategy instead of hardwiring `processNode`. Local execution and Temporal dispatch become interchangeable strategies.

## 1. The ExecutionStrategy Interface

```typescript
// packages/dagraph/src/strategy.ts

export interface ExecutionStrategy {
  /**
   * Execute a single node given its dependency content hashes and outputs.
   * This is the sole extension point -- everything else (graph validation,
   * scheduling, orchestration) remains in dagraph's core.
   */
  runNode(
    node: Node,
    depContentHashes: Map<string, string>,
    depOutputs: Record<string, Outputs>,
  ): Promise<ProcessNodeResult>;

  /**
   * Optional: provide a scheduler tailored to this strategy.
   * If omitted, execute() uses the caller's scheduler or the default.
   */
  scheduler?(): Scheduler;
}
```

**Design decision: thin interface.** The strategy is intentionally just a `RunNode` with an optional scheduler hint. It does not carry retry configuration, timeout policy, or routing rules as separate methods. Those are strategy-internal concerns. A Temporal strategy encapsulates `proxyActivities` + `TEMPORAL_TASK_CONFIG` inside its `runNode`. A local strategy encapsulates `processNode` + `ExecutionContext` inside its `runNode`. The interface doesn't need to know about either.

**Relationship to `RunNode`.** `ExecutionStrategy.runNode` has the exact same signature as the existing `RunNode` type. The strategy is a `RunNode` bundled with optional scheduler configuration. `orchestrate()` continues to accept a raw `RunNode` for callers who want the lower-level API.

## 2. Local Strategy

```typescript
// packages/dagraph/src/strategies/local.ts

export interface LocalStrategyOptions {
  graph: Graph;
  ctx: ExecutionContext;
  force?: boolean;
  scheduling?: ThrottledSchedulerOptions;
}

export function localStrategy(opts: LocalStrategyOptions): ExecutionStrategy {
  const nodes = opts.graph.getNodes();
  return {
    runNode(desc, depContentHashes, depOutputs) {
      const node = nodes.get(desc.name)!;
      return processNode(node, depContentHashes, depOutputs, opts.ctx, {
        force: opts.force ?? false,
      });
    },
    scheduler() {
      return opts.scheduling
        ? throttledScheduler(opts.scheduling)
        : unboundedScheduler();
    },
  };
}
```

This is almost zero new code. The body of `runNode` is the exact lambda currently inside `execute()` at lines 35-38 of `packages/dagraph/src/execute.ts`.

## 3. Temporal Strategy

```typescript
// src/cli/commands/serve/temporal-strategy.ts
// (lives in the app, NOT in dagraph -- Temporal is an app concern)

import type { ExecutionStrategy } from "@podpiper/dagraph";
import { unboundedScheduler } from "@podpiper/dagraph";
import { proxyActivities } from "@temporalio/workflow";

export interface TemporalStrategyOptions {
  channelName: string;
  video: { videoId: string; uploadDate: string; title: string };
}

export function temporalStrategy(opts: TemporalStrategyOptions): ExecutionStrategy {
  return {
    runNode(desc, depContentHashes, depOutputs) {
      const activityOpts = TEMPORAL_TASK_CONFIG[desc.kind as NodeKind] ?? {
        taskQueue: TASK_QUEUES.default,
        startToCloseTimeout: "5m",
      };
      const acts = proxyActivities<Activities>(activityOpts);
      const activity = acts[desc.kind as VideoNodeKind];
      return activity({
        channelName: opts.channelName,
        video: opts.video,
        nodeName: desc.name,
        kind: desc.kind,
        depContentHashes: Object.fromEntries(depContentHashes),
        depOutputs,
      });
    },
    scheduler() {
      return unboundedScheduler();
    },
  };
}
```

Direct extraction of the `run` lambda currently at lines 46-57 of `src/cli/commands/serve/workflows.ts`. The strategy encapsulates the Temporal-specific `proxyActivities` call, task queue routing, and serialization.

## 4. How execute() Changes

```typescript
// packages/dagraph/src/execute.ts (new version)

export interface ExecuteOptions {
  onEvent?: (event: ExecEvent) => void;
  scheduler?: Scheduler;
}

export async function execute(
  graph: Graph,
  strategy: ExecutionStrategy,
  opts?: ExecuteOptions,
): Promise<ExecResult[]> {
  const nodes = graph.getNodes();
  validateNoCycles(nodes);
  const scheduler =
    opts?.scheduler ?? strategy.scheduler?.() ?? unboundedScheduler();
  return orchestrate(
    nodes.values(),
    (node, depContentHashes, depOutputs) =>
      strategy.runNode(node, depContentHashes, depOutputs),
    scheduler,
    opts?.onEvent,
  );
}
```

Key changes:
- **Second parameter changes from `ctx: ExecutionContext` to `strategy: ExecutionStrategy`.** The `ExecutionContext` moves into the strategy (for local) or becomes irrelevant (for Temporal).
- **Graph validation stays in `execute()`** -- cycle detection is structural, not strategy-dependent.
- **Scheduler resolution:** caller override > strategy hint > unbounded default.

**Breaking change.** The single app call site in `src/pipeline/execute.ts` changes from:

```typescript
const results = await execute(graph, executionCtx, opts);
```

to:

```typescript
const results = await execute(
  graph,
  localStrategy({ graph, ctx: executionCtx, force: opts?.force, scheduling: opts?.scheduling }),
  opts,
);
```

## 5. The Graph Rebuild Problem

**With the strategy pattern, the activity-side graph rebuild does not change.** The Temporal strategy's `runNode` dispatches to an activity. The activity still needs the closure to run the action. Since closures cannot cross process boundaries, the activity must reconstruct them.

**Is this acceptable?** Yes, for three reasons:

1. **Graph construction is cheap.** `buildVideoGraph` creates ~7 node objects. The expensive work is the action itself (downloading, transcribing).

2. **It is correct by construction.** Rebuilding from the same `(video, ports, config)` inputs guarantees the activity gets the same closure.

3. **The alternative is worse.** Serializing closures (via `eval` or stringification) would be fragile, insecure, and sandbox-hostile. The rebuild pattern is standard (Airflow, Prefect, Dagster all reconstruct callables on the worker side).

**Possible future improvement:** Extract a `NodeResolver` interface for the activity layer:

```typescript
interface NodeResolver {
  resolve(nodeName: string): RunnableNode;
}
```

Not necessary for the initial refactor.

## 6. Composability

Strategies compose via wrapping (decorator pattern):

```typescript
function withLogging(inner: ExecutionStrategy, log: Logger): ExecutionStrategy {
  return {
    runNode(node, depContentHashes, depOutputs) {
      log.info(`Starting ${node.name}`);
      return inner.runNode(node, depContentHashes, depOutputs).then(r => {
        log.info(`Finished ${node.name}: ${r.status}`);
        return r;
      });
    },
    scheduler: inner.scheduler,
  };
}
```

Realistic composed strategies:
- **Dry-run strategy:** wraps any strategy, returns synthetic "would-run" results without executing.
- **Metrics strategy:** records timing/status to a metrics backend.
- **Fallback strategy:** tries remote, falls back to local on failure.

## 7. Risks and Trade-offs

### Over-abstraction for two use cases?

The interface is minimal (one required method). The local strategy is a 10-line function. The real value is not in having N strategies but in making `execute()` the single entry point for all modes, eliminating the split between `execute()` and manual `orchestrate()` wiring.

### Breaking change to execute()

Every caller must update. There is exactly one call site in the app. dagraph's tests also need updates.

### Leaking Temporal concerns into dagraph?

The `ExecutionStrategy` interface is Temporal-agnostic. It mentions no Temporal types. The Temporal strategy implementation lives in the app. dagraph only exports the interface and the local strategy.

### Strategy needs graph access for local mode

The local strategy closes over `graph.getNodes()` to look up `RunnableNode` by name. The graph is passed to both `execute()` (for validation/orchestration) and the strategy (for node lookup). This slight duplication is acceptable -- the strategy needs `RunnableNode` (with closure) while `orchestrate()` only needs `Node` (without closure).

### Scheduler ownership ambiguity

Three sources can provide a scheduler: caller, strategy, default. The precedence chain is clear but adds a decision point. In practice, callers rarely override the scheduler.

### Doesn't address routing duplication

This plan promotes `RunNode` to a named interface but doesn't eliminate `TEMPORAL_TASK_CONFIG`. The side mapping from kind to task queue still lives in the Temporal strategy. This could be combined with Plan B's execution metadata to fully resolve both tensions.

## 8. Steel-Manning

**The strategy pattern is the standard answer to "same algorithm, different execution backends."**

Precedents:
- **Database drivers** (`sql.DB` in Go, `DataSource` in Java): query planner is fixed; the driver implements how to talk to a specific database.
- **HTTP transports** (Go's `http.RoundTripper`, Python's `requests.adapters`): client handles redirects/cookies; transport implements how to send bytes.
- **DAG execution engines** (Dagster's `Executor`, Airflow's `Executor`): scheduler determines order; executor determines where the task runs.

**The current code already has the seam.** The `RunNode` type is exactly this abstraction, just unnamed and unpackaged. The strategy pattern gives it a name, a home, and a place to attach related configuration (scheduler hint). It is not adding abstraction where none exists -- it is promoting an implicit abstraction to an explicit one.

**The strategy boundary aligns with the process boundary.** Local = direct closure access. Temporal = serialize and dispatch. This is the natural split point.

**`execute()` becomes the universal entry point.** The Temporal workflow can call `execute(graph, temporalStrategy(...))` instead of manually calling `orchestrate()` with a hand-rolled RunNode. This eliminates the "two ways to start a DAG" problem.

## Implementation Sequence

### Phase 1: Define interface and local strategy (dagraph-only)
1. Create `packages/dagraph/src/strategy.ts` with `ExecutionStrategy`
2. Create `packages/dagraph/src/strategies/local.ts` with `localStrategy()`
3. Update `execute()` to accept `ExecutionStrategy`
4. Export new types from `index.ts`
5. Update dagraph unit tests

### Phase 2: Migrate the app's local path
6. Update `src/pipeline/execute.ts` to construct a `localStrategy`
7. Remove backward-compatible overloads

### Phase 3: Create the Temporal strategy
8. Create `src/cli/commands/serve/temporal-strategy.ts`
9. Refactor `videoWorkflow` to use `execute(graph, temporalStrategy(...))`
10. This requires `execute()` to accept `Iterable<Node>` as alternative to `Graph`, or an `executeFromDescriptors()` variant

### Phase 4: Cleanup
11. Consider whether `orchestrate()` should remain public API
12. Update documentation
13. Remove shims

## Critical Files

| File | Change |
|------|--------|
| `packages/dagraph/src/strategy.ts` | **New.** `ExecutionStrategy` interface. |
| `packages/dagraph/src/strategies/local.ts` | **New.** `localStrategy()` factory. |
| `packages/dagraph/src/execute.ts` | Accept `ExecutionStrategy` instead of `ExecutionContext`. |
| `packages/dagraph/src/index.ts` | Export `ExecutionStrategy`, `localStrategy`. |
| `src/pipeline/execute.ts` | Construct `localStrategy` for `sync()`. |
| `src/cli/commands/serve/temporal-strategy.ts` | **New.** `temporalStrategy()` factory. |
| `src/cli/commands/serve/workflows.ts` | Use `temporalStrategy` + `execute()` instead of manual `orchestrate()`. |
