# 02 — Readiness-Loop Scheduling

## What

Replace level-by-level execution with a readiness loop that dispatches nodes as soon as all their dependencies complete, regardless of depth.

## Why

Better parallelism. In the current level-by-level approach, all nodes at depth N must complete before any node at depth N+1 starts. A readiness loop lets a node run as soon as its specific deps finish. For example, if `thumbnail:vid_a` only depends on `download:vid_a` and that download finishes first, the thumbnail starts immediately without waiting for all other downloads.

## Dependencies

None — independent engine refactor. Can be done before or after planning phase (#1).

## Key Files

- `src/dag/graph.ts` — `execute()` method (lines 80–168). Replace the `for (let d = 0; d <= maxDepth; d++)` loop with a readiness loop.

## Current State

```
topoSort → assign depths → for each depth level:
  dispatch all nodes at this depth (with semaphore)
  await Promise.all
  move to next depth
```

All nodes at depth 2 wait for ALL depth-1 nodes, even if their specific deps finished early.

## Target State

```
topoSort → initialize in-degree counts → seed ready queue with zero-dep nodes
loop:
  dequeue a ready node (respecting semaphore)
  dispatch it
  on completion: decrement in-degree of dependents, enqueue any that hit zero
  repeat until all nodes done
```

## Implementation Notes

- The semaphore logic already exists and can be reused. The change is in how nodes are dispatched — driven by dependency completion instead of depth layers.
- Track in-degree (number of unfinished deps) for each node. When a node completes, decrement in-degree of all its dependents. Any dependent that reaches zero in-degree is ready.
- Error propagation: when a node fails, mark all transitive dependents as failed (same as current behavior).
- The toposort is still needed for deterministic ordering among equally-ready nodes.
