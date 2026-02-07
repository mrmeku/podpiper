# 04 — Progress Event Emission

## What

Add a callback mechanism so the executor emits progress events as nodes execute:

```typescript
interface ProgressEvent {
  node: string; // "transcribe:vid_abc123"
  nodeType: string; // "transcribe"
  status: "start" | "done" | "fail";
}

type ProgressCallback = (event: ProgressEvent) => void;
```

## Why

Foundation for any live UI — CLI progress bars, future web UI, Temporal heartbeats. Without this, execution is opaque: `graph.execute()` returns results at the end with no mid-execution visibility.

## Dependencies

**Readiness-Loop (#2)** — progress events should be built on top of the readiness-loop executor. The level-by-level executor would emit misleading progress (all nodes at a depth start simultaneously, then nothing until the next depth).

## Key Files

- `src/dag/graph.ts` — emit events around `node.action()` / runner invocation
- `src/dag/types.ts` — add `ProgressEvent` and `ProgressCallback` types

## Current State

`Graph.execute()` returns `ExecResult[]` at the end. No mid-execution visibility. The CLI in `src/cli.ts` (lines 130–146) prints results after completion.

## Target State

```typescript
// Execute with progress callback
graph.execute(runner, (event) => {
  console.log(`${event.status} ${event.node}`);
});
```

Events are only emitted for dirty nodes — pruned/cached nodes are already accounted for in the `PlanningResult` (from #1). A CLI updates its per-type progress bars as `done` events arrive.

## Implementation Notes

- `nodeType` is derived from node name: everything before the first `:` (e.g., `transcribe:vid_abc` → `transcribe`)
- The callback is synchronous (no `async`) — it should not block execution. Consumers that need async (like writing to a log) should buffer internally.
- `fail` events include the error in the `ExecResult`, not in the progress event. The event signals timing; the result carries details.
