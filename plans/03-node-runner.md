# 03 — NodeRunner Abstraction

## What

Extract node execution into a `NodeRunner` interface. The executor delegates to the runner instead of calling `node.action(inputs)` directly.

```typescript
type NodeRunner = (node: Node, inputs: Record<string, string>) => Promise<string>;
```

## Why

- Single swap point between local and distributed execution (Temporal)
- Retry/backoff policies live in the runner, not the executor
- Testing: inject a mock runner to test executor logic without running real actions

## Dependencies

None — independent engine refactor.

## Key Files

- `src/dag/types.ts` — add `NodeRunner` type
- `src/dag/graph.ts` — `execute()` signature changes, `node.action(inputs)` becomes `runner(node, inputs)`
- `src/pipeline/sync.ts` — update `graph.execute(maxParallelism)` call
- `src/dag/dag.test.ts` — update `g.execute(1)` call

## Current State

`Graph.execute()` has signature `execute(maxParallelism = 4)` and calls `node.action(inputs)` directly at line 142. There's no indirection — the executor is coupled to in-process execution.

**All callers of `execute()`:**

| Call site                              | Current call                    | Passes args?      |
| -------------------------------------- | ------------------------------- | ----------------- |
| `src/pipeline/sync.ts:24`              | `graph.execute(maxParallelism)` | Yes — number      |
| `src/dag/dag.test.ts:282`              | `g.execute(1)`                  | Yes — number      |
| `src/dag/dag.test.ts` (14 other calls) | `.execute()`                    | No — uses default |

## Target State

```typescript
// types.ts
type NodeRunner = (node: Node, inputs: Record<string, string>) => Promise<string>;

// graph.ts
const localRunner: NodeRunner = (node, inputs) => node.action(inputs);

// execute() gains runner as first param, defaulting to localRunner
graph.execute(localRunner, maxParallelism);
```

The `Node` interface keeps its `action` field — the runner is a strategy for _how_ to invoke the action (locally, via Temporal, with retries), not a replacement for the action definition.

## Implementation Plan

### Step 1: Add `NodeRunner` type to `src/dag/types.ts`

Add after the `ActionFunc` type on line 1:

```typescript
export type NodeRunner = (node: Node, inputs: Record<string, string>) => Promise<string>;
```

This depends on the `Node` type defined in the same file, so place it after the `Node` interface (after line 9).

### Step 2: Add `localRunner` and update `execute()` signature in `src/dag/graph.ts`

Export a `localRunner` constant and change `execute()` to accept the runner as its first parameter:

```typescript
import type {
  Cache,
  ExecResult,
  Flushable,
  Node,
  NodeCounts,
  NodeRunner,
  PlanningResult,
} from "./types";

export const localRunner: NodeRunner = (node, inputs) => node.action(inputs);
```

Change execute signature from:

```typescript
async execute(maxParallelism = 4): Promise<ExecResult[]>
```

To:

```typescript
async execute(runner: NodeRunner = localRunner, maxParallelism?: number): Promise<ExecResult[]>
```

In the readiness loop, make the `inflight < maxParallelism` gate conditional:

```typescript
while (ready.length > 0 && (maxParallelism == null || inflight < maxParallelism)) {
```

When `maxParallelism` is omitted, the gate is always open — all ready nodes dispatch immediately.

### Step 3: Replace `node.action(inputs)` with `runner(node, inputs)`

In `processNode` (line 142), change:

```typescript
const result = await node.action(inputs);
```

To:

```typescript
const result = await runner(node, inputs);
```

This is the only line in the codebase where a node's action is invoked during execution.

### Step 4: Update callers

**`src/pipeline/sync.ts:24`** — currently `graph.execute(maxParallelism)`:

```typescript
import { localRunner } from "@/dag/graph";

const results = await graph.execute(localRunner, maxParallelism);
```

**`src/dag/dag.test.ts:282`** — currently `g.execute(1)`:

```typescript
import { localRunner } from "./graph";

await g.execute(localRunner, 1);
```

All other `execute()` calls (14 of them in `dag.test.ts`) use no arguments and work unchanged via defaults.

### Step 5: Add test — mock runner isolates executor logic

Add a test that injects a mock runner to verify the executor's orchestration (scheduling, caching, dependency wiring) without running real actions. This validates the core value proposition of the abstraction.

```typescript
test("mock runner: executor calls runner instead of node.action", async () => {
  const cache = new MemCache();
  const g = new Graph(cache);
  const calls: string[] = [];

  g.add({
    name: "root",
    kind: "root",
    deps: [],
    config: "cfg",
    action: async () => "should not be called",
  });
  g.add({
    name: "child",
    kind: "child",
    deps: ["root"],
    config: "cfg",
    action: async () => "should not be called",
  });

  const mockRunner: NodeRunner = async (node, inputs) => {
    calls.push(node.name);
    return `result:${node.name}`;
  };

  const results = await g.execute(mockRunner);
  expect(calls).toEqual(["root", "child"]);
  const childResult = results.find((r) => r.name === "child");
  expect(childResult?.result).toBe("result:child");
});
```

This test exercises that:

1. The runner is called instead of `node.action`
2. Dependency ordering is respected (root before child)
3. Runner results flow through as `ExecResult.result`

### Step 6: Verify all existing tests pass

Run `bun test src/dag/dag.test.ts`. All existing tests should pass unchanged since `localRunner` is the default and is behaviorally identical to the previous `node.action(inputs)` call.

## What Doesn't Change

| Concern             | Why unchanged                                                   |
| ------------------- | --------------------------------------------------------------- |
| `computeHash()`     | Hash computation is per-node, independent of how actions run    |
| `plan()`            | Analysis only — no action execution, no runner involvement      |
| Cache semantics     | Same get/put/flush lifecycle, runner doesn't affect caching     |
| Error propagation   | Runner throws → `processNode` catches → same `failed` set logic |
| `Node` interface    | Keeps `action` field — runner wraps it, doesn't replace it      |
| Return type         | Same `ExecResult[]`                                             |
| `processNode` logic | Identical except the one `node.action` → `runner` swap          |

## Forward Compatibility

**Plan 04 (Progress Events):** Will add a progress callback to `execute()`. Two options at that point:

- Add as third positional param: `execute(runner, maxParallelism, onProgress)` — still workable
- Switch to options bag: `execute({ runner, maxParallelism, onProgress })` — cleaner if more params come

Either way, the `NodeRunner` abstraction introduced here is independent of how `execute()`'s parameter list evolves.

**Plan 06 (Temporal):** The Temporal runner will implement `NodeRunner`, dispatching nodes as Temporal activities:

```typescript
const temporalRunner: NodeRunner = async (node, inputs) => {
  return workflow.executeActivity(node.name, { node, inputs });
};
graph.execute(temporalRunner); // no maxParallelism — Temporal handles scheduling
```

## Risks

- **None significant.** This is a mechanical refactor — one new type, one new constant, one line swap in `processNode`, two caller updates. The local runner is identity-like (`(node, inputs) => node.action(inputs)`), so behavior is preserved by construction.
