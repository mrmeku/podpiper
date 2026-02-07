# 01 — DAG Planning Phase

## What

Separate hash computation + cache checking from execution. Walk the full DAG upfront, produce a `PlanningResult` with per-type breakdown (cached vs dirty counts). Execution then uses the same graph — cached nodes are skipped as before, but the counts are known upfront.

## Why

- Enables dry-run mode (`sync --dry-run`) — preview what work would happen without executing
- Gives the CLI a complete picture before any work starts (foundation for progress display)

## Dependencies

None — independent engine refactor.

## Key Files

- `src/dag/graph.ts` — hash + cache check currently happens inline during level-by-level execution (lines 122–136). Needs to be pulled into a separate `plan()` method.
- `src/dag/types.ts` — add `PlanningResult` type

## Current State

`Graph.execute()` does everything: toposort, depth assignment, level-by-level iteration, and within each node: hash computation, cache check, action execution. Planning is interleaved with execution — there's no point where you know what's cached and what's dirty before work starts.

## Target State

```typescript
interface NodeCounts {
  total: number;
  cached: number;
  dirty: number;
}

interface PlanningResult {
  totalCounts: NodeCounts;
  byType: Map<string, NodeCounts>;
}

// Usage:
const plan = graph.plan();
// CLI can display plan.byType breakdown here
const results = graph.execute(); // same graph, cached nodes still skipped during execution
```

## Implementation Notes

- `plan()` walks the full DAG in topological order, computes every Merkle hash, and checks each against the cache. No side effects, no action execution.
- `execute()` still operates on the full graph. When it encounters a cached node, it loads the result from cache and skips the action — same as today. The planning phase just front-loads the counting.
- `nodeType` is derived from node name: everything before the first `:` (e.g., `download:vid_abc` → `download`, `channel_avatar` → `channel_avatar`)
- No separate pruned graph, no preloaded inputs map. The cache is the bridge between cached and dirty nodes — same mechanism that already works.
