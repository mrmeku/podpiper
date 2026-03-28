# Plan B: Execution Metadata on Node Descriptors

## Motivation

dagraph models DAG topology and a single scheduling hint (`concurrencyGroup`) on its serializable `Node` descriptor. But the Temporal integration needs richer scheduling information -- task queue routing, timeouts, and retry policies -- which lives in a separate `TEMPORAL_TASK_CONFIG` mapping keyed by `NodeKind`. This creates two problems:

1. **Parallel maintenance.** Every time a new action kind is added or its resource profile changes, two locations must be updated in lockstep: the action definition (which sets `concurrencyGroup`) and `task-config.ts` (which sets `taskQueue`, `startToCloseTimeout`, `retry`). They can drift.

2. **The graph is not self-describing.** A `Node[]` array shipped to a Temporal workflow carries topology and `kind` but not enough for the workflow to make scheduling decisions. The workflow must consult a side table re-deriving what the action author already knew at definition time.

## What This Plan Does NOT Address

**Action closures cannot cross serialization boundaries.** The `RunnableNode.action` field is a closure that captures ports. The Temporal side must still rebuild the graph or use a registry to recover executable functions.

This plan does not change that. The `execution` field is purely declarative -- it tells an executor *how to schedule* a node, not *what code to run*. The closure problem is orthogonal.

**Why solving routing alone is still valuable:** The routing duplication is a source of real bugs. If someone adds a `NodeKind` and forgets `TEMPORAL_TASK_CONFIG`, the workflow silently falls back to a default 5-minute timeout. With execution metadata on the descriptor, the action author declares intent once.

## Execution Metadata Schema

The schema must be generic -- dagraph is reusable with no knowledge of Temporal or any specific executor.

```typescript
// packages/dagraph/src/graph/types.ts

export interface ExecutionMeta {
  /**
   * Named resource class this node needs. Executors map this to a concrete
   * resource pool (Temporal task queue, k8s node selector, local concurrency group).
   * Replaces concurrencyGroup.
   * Examples: "gpu", "cpu-heavy", "llm", "default"
   */
  resourceClass?: string;

  /**
   * Maximum wall-clock time for execution.
   * ISO 8601 duration string (e.g., "PT15M").
   */
  timeout?: string;

  /**
   * Maximum time from scheduling to completion (includes queue wait).
   * ISO 8601 duration string. Only meaningful for distributed executors.
   */
  scheduleTimeout?: string;

  /**
   * Retry policy. Executors that support retries use this; others ignore it.
   */
  retry?: {
    maxAttempts?: number;
    backoffMultiplier?: number;
    maxInterval?: string;
  };

  /**
   * Maximum parallel instances of nodes sharing the same resourceClass.
   * Used by the local throttled scheduler. Distributed executors typically
   * enforce this via worker pool sizing.
   */
  maxConcurrency?: number;
}

export interface Node {
  name: string;
  kind: string;
  deps: string[];
  config: string;
  /** @deprecated Use execution.resourceClass instead. */
  concurrencyGroup?: string;
  execution?: ExecutionMeta;
}
```

**Design choices:**
- **`resourceClass` is a string, not an enum** -- dagraph doesn't know what resource classes exist.
- **`maxConcurrency` on the metadata** -- it's a property of the resource class as declared by the action author, not a global knob.
- **Optional everything** -- nodes with no `execution` get executor defaults.

## How It Replaces `concurrencyGroup`

Today in `src/pipeline/actions/transcribe.ts`:

```typescript
export const transcribe = defineActionWithPorts<TranscribeParams, TranscribeResult>({
  config: "whisper-v1,model=large-v3-turbo",
  concurrencyGroup: "whisper",
  action: (ports) => async (_params, inputs, outputDir) => { ... },
});
```

After:

```typescript
export const transcribe = defineActionWithPorts<TranscribeParams, TranscribeResult>({
  config: "whisper-v1,model=large-v3-turbo",
  execution: {
    resourceClass: "gpu",
    timeout: "PT15M",
    retry: { maxAttempts: 3, backoffMultiplier: 2 },
    maxConcurrency: 1,
  },
  action: (ports) => async (_params, inputs, outputDir) => { ... },
});
```

`concurrencyGroup: "whisper"` carried two pieces of implicit information: (a) this node needs a specific resource pool, and (b) only one should run at a time locally. Now both are explicit.

## How It Replaces `TEMPORAL_TASK_CONFIG`

Today, `src/cli/commands/serve/task-config.ts` maintains a 60-line mapping. The workflow reads it:

```typescript
function activityOptions(kind: string): ActivityOptions {
  return TEMPORAL_TASK_CONFIG[kind as NodeKind] ?? {
    taskQueue: TASK_QUEUES.default,
    startToCloseTimeout: "5m",
  };
}
```

After, the workflow reads execution metadata from the descriptor:

```typescript
function activityOptions(execution?: ExecutionMeta): ActivityOptions {
  return {
    taskQueue: mapResourceClassToQueue(execution?.resourceClass),
    startToCloseTimeout: execution?.timeout ?? "5m",
    ...(execution?.scheduleTimeout && {
      scheduleToCloseTimeout: execution.scheduleTimeout,
    }),
    retry: execution?.retry
      ? {
          maximumAttempts: execution.retry.maxAttempts,
          backoffCoefficient: execution.retry.backoffMultiplier,
          ...(execution.retry.maxInterval && {
            maximumInterval: execution.retry.maxInterval,
          }),
        }
      : undefined,
  };
}

function mapResourceClassToQueue(resourceClass?: string): string {
  switch (resourceClass) {
    case "gpu":     return TASK_QUEUES.whisper;
    case "llm":     return TASK_QUEUES.claude;
    default:        return TASK_QUEUES.default;
  }
}
```

The call site changes from `activityOptions(desc.kind)` to `activityOptions(desc.execution)`.

`TEMPORAL_TASK_CONFIG` is deleted. The small `mapResourceClassToQueue` is the only Temporal-specific mapping that remains -- a thin, obvious translation from abstract resource classes to concrete queue names.

## How `throttledScheduler` Evolves

```typescript
export interface ThrottledSchedulerOptions {
  maxParallelism?: number;
  concurrencyOverrides?: Record<string, number>;
  /** @deprecated Use execution metadata on nodes instead. */
  concurrencyLimits?: Record<string, number>;
}

export function throttledScheduler(opts?: ThrottledSchedulerOptions): Scheduler {
  const { maxParallelism, concurrencyLimits, concurrencyOverrides } = opts ?? {};

  return schedulingLoop({
    filter(node) {
      if (maxParallelism != null && inflight >= maxParallelism) return false;

      const group = node.execution?.resourceClass ?? node.concurrencyGroup;
      if (!group) return true;

      const limit =
        concurrencyOverrides?.[group] ??
        concurrencyLimits?.[group] ??
        node.execution?.maxConcurrency;
      return limit == null || (groupInflight.get(group) ?? 0) < limit;
    },
  });
}
```

The concurrency limit is now co-located with the node definition via `maxConcurrency`, not only supplied as a global option. The caller can still override via `concurrencyOverrides` (e.g., a beefy CI machine might set `{ gpu: 2 }`).

**Backward compatibility:** The old `concurrencyGroup` and `concurrencyLimits` continue to work, marked `@deprecated`. The scheduler checks `execution?.resourceClass` first, falling back to `concurrencyGroup`.

## How the Temporal Workflow Simplifies

Before: `Node[] descriptors ---> TEMPORAL_TASK_CONFIG[desc.kind] ---> ActivityOptions`

After: `Node[] descriptors ---> desc.execution ---> ActivityOptions`

The `Node` descriptor already survives JSON serialization. The workflow no longer imports `NodeKind` or `TEMPORAL_TASK_CONFIG`. It no longer needs to know the application's action taxonomy to make scheduling decisions.

**Structural benefit: new action kinds do not require workflow code changes.** Today, adding a `NodeKind` requires adding a `TEMPORAL_TASK_CONFIG` entry. After this plan, the action author declares `execution: { resourceClass: "gpu", timeout: "PT10M" }` and the workflow routes it correctly.

## Risks and Trade-offs

### Does this make dagraph too Temporal-aware?

No. The schema uses generic terms: `resourceClass` (not `taskQueue`), `timeout` (not `startToCloseTimeout`). These concepts exist in every execution environment:

- **Local executor:** `resourceClass` maps to concurrency groups; `timeout` could drive a `setTimeout` wrapper.
- **Temporal:** Fields map to `ActivityOptions`.
- **Kubernetes Jobs:** `resourceClass` maps to node selectors; `timeout` maps to `activeDeadlineSeconds`.

The analogy is **Kubernetes pod specs**: the workload declares what it needs; the platform interprets it.

### Cache invalidation when execution metadata changes

Execution metadata describes *how* to run, not *what* to run. Changing a timeout does not change the output. The `config` string (which feeds the content-addressed cache key) should NOT include `execution`. This is naturally the case since `config` is explicitly set by the action author.

### Doesn't solve the closure problem

Correct. Actions still need to be resolved via closures. The Temporal activity side still rebuilds the graph. This plan is scoped to eliminating the routing duplication and making the graph self-describing for scheduling -- a real, standalone improvement.

### Migration risk

The backward-compatible fallback (`execution?.resourceClass ?? concurrencyGroup`) means Phase 1 and Phase 2 can deploy independently. Actions migrate one at a time. No flag day.

## Steel-Manning

**Single source of truth.** The action author knows best what resources their action needs. Declaring `execution: { resourceClass: "gpu", timeout: "PT15M", maxConcurrency: 1 }` at definition time is the natural place. Requiring a separate side table maintained by someone else editing `task-config.ts` is a liability.

**Self-describing graphs.** A `Node[]` becomes a complete scheduling specification. Any executor can read the descriptors and make correct decisions without application-specific lookup tables.

**Incremental and safe.** Adds a new optional field. Nothing breaks until you use it. The old path continues to work.

**Reduced coupling.** The Temporal workflow currently imports `NodeKind` (an application-domain enum) for infrastructure routing. After this plan, it only reads generic `ExecutionMeta` fields. The workflow becomes truly generic.

## Implementation Sequence

### Phase 1: Add `ExecutionMeta` to dagraph (non-breaking)
1. Add `ExecutionMeta` interface to `packages/dagraph/src/graph/types.ts`
2. Add optional `execution` field to `Node`
3. Thread `execution` through `defineAction` spec
4. Thread `execution` through `addNode`
5. Verify `graph.describe()` includes `execution` (it strips only `action` and `params`)
6. Export `ExecutionMeta` from `index.ts`
7. Update `throttledScheduler` to read `execution?.resourceClass` with fallback
8. Add tests for new scheduler behavior

### Phase 2: Migrate action definitions
9. Define resource class constants in `src/pipeline/actions/define-action.ts`
10. Add `execution` metadata to each action, one at a time
11. Remove `concurrencyGroup` from migrated actions

### Phase 3: Migrate Temporal workflow
12. Add `mapResourceClassToQueue` function
13. Rewrite `activityOptions` to read `desc.execution`
14. Delete `TEMPORAL_TASK_CONFIG` from `task-config.ts`
15. Keep `TASK_QUEUES` constants

### Phase 4: Cleanup
16. Remove `concurrencyGroup` from `Node` (or leave deprecated)
17. Remove `concurrencyLimits` from `ThrottledSchedulerOptions` (or leave deprecated)
18. Update local `execute()` call sites to stop passing `concurrencyLimits`

## Critical Files

| File | Change |
|------|--------|
| `packages/dagraph/src/graph/types.ts` | `ExecutionMeta` interface, `Node.execution` field |
| `packages/dagraph/src/define-action.ts` | Thread `execution` from spec to node |
| `packages/dagraph/src/schedulers.ts` | Read `execution.resourceClass` and `maxConcurrency` |
| `packages/dagraph/src/graph/add-node.ts` | Pass `execution` through to node |
| `src/pipeline/actions/*.ts` | Add `execution` metadata to each action |
| `src/cli/commands/serve/workflows.ts` | Rewrite `activityOptions` to read `desc.execution` |
| `src/cli/commands/serve/task-config.ts` | Largely deleted |
