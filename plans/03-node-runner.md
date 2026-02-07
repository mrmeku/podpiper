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

- `src/dag/graph.ts` — line 142: `const result = await node.action(inputs);` becomes `const result = await runner(node, inputs);`
- `src/dag/types.ts` — add `NodeRunner` type
- New: runner implementations (local runner, eventually Temporal runner)

## Current State

`Graph.execute()` calls `node.action(inputs)` directly at line 142. There's no indirection — the executor is coupled to in-process execution.

## Target State

```typescript
type NodeRunner = (node: Node, inputs: Record<string, string>) => Promise<string>;

// Local runner — just calls the action directly
const localRunner: NodeRunner = (node, inputs) => node.action(inputs);

// Graph accepts runner as parameter
graph.execute(runner);
```

## Implementation Notes

- The local runner is trivial: `(node, inputs) => node.action(inputs)`. It can later be wrapped with retry/backoff logic for flaky operations (YouTube downloads, LLM APIs).
- The runner receives the full `Node` object so it has access to `node.name`, `node.config`, and `node.deps` for logging, metrics, or Temporal activity options.
- This is a minimal interface change — `execute()` gains one parameter, and the default can be the local runner for backward compatibility.
