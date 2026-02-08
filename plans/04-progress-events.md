# 04 — Progress Event Emission

## What

Add a callback mechanism so the executor emits progress events as nodes execute:

```typescript
type ProgressEventBase = { node: string; kind: string };

type ProgressEvent = ProgressEventBase &
  (
    | { status: "start" }
    | { status: "done"; elapsed: number }
    | { status: "cached" }
    | { status: "fail"; error: string; elapsed: number }
    | { status: "dep-failed"; error: string }
  );

type ProgressCallback = (event: ProgressEvent) => void;
```

## Why

Foundation for any live UI — CLI progress bars, future web UI, Temporal heartbeats. Without this, execution is opaque: `graph.execute()` returns results at the end with no mid-execution visibility.

## Dependencies

**Readiness-Loop (#2)** — progress events should be built on top of the readiness-loop executor. Already implemented.

## Key Files

- `src/dag/types.ts` — add `ProgressEvent`, `ProgressCallback`, `ExecuteOptions` types
- `src/dag/graph.ts` — change `execute()` signature, emit events in `processNode()`
- `src/pipeline/sync.ts` — thread callback through to `graph.execute()` via options bag
- `src/dag/dag.test.ts` — tests for event emission

## Current State

`Graph.execute(runner, maxParallelism?)` returns `ExecResult[]` at the end. No mid-execution visibility. The CLI in `src/cli.ts` prints results after completion via `printResults()`.

## Target State

```typescript
graph.execute(runner, {
  maxParallelism: 4,
  onProgress: (event) => console.log(`${event.status} ${event.node}`),
});
```

The event stream is a self-contained execution log — every node emits at least one event. Terminal events include timing and error detail so consumers don't need to cross-reference with `ExecResult[]`.

## Design Decisions

**Why `runner` stays outside the options bag:** Plan 03 suggested either `execute(runner, maxParallelism, onProgress)` or `execute({ runner, maxParallelism, onProgress })`. The hybrid `execute(runner, opts?)` is intentional — `runner` is the fundamental dispatch strategy (local vs Temporal), while the bag holds optional execution config. The runner is always required for non-default usage; config params are always optional.

## Implementation

### Step 1: Add types to `src/dag/types.ts`

```typescript
export type ProgressEventBase = { node: string; kind: string };

export type ProgressEvent = ProgressEventBase &
  (
    | { status: "start" }
    | { status: "done"; elapsed: number }
    | { status: "cached" }
    | { status: "fail"; error: string; elapsed: number }
    | { status: "dep-failed"; error: string }
  );

export type ProgressCallback = (event: ProgressEvent) => void;

export interface ExecuteOptions {
  maxParallelism?: number;
  onProgress?: ProgressCallback;
}
```

### Step 2: Change `execute()` signature in `src/dag/graph.ts`

Before:

```typescript
async execute(runner: NodeRunner = localRunner, maxParallelism?: number): Promise<ExecResult[]>
```

After:

```typescript
async execute(runner: NodeRunner = localRunner, opts?: ExecuteOptions): Promise<ExecResult[]>
```

Destructure at the top of the method:

```typescript
const { maxParallelism, onProgress } = opts ?? {};
```

### Step 3: Emit events in `processNode()`

Five emission points covering every code path:

| Scenario                         | Events emitted   | `elapsed`    | `error`           |
| -------------------------------- | ---------------- | ------------ | ----------------- |
| Cached node (hash hit)           | `cached`         | —            | —                 |
| Dirty node executes successfully | `start` → `done` | ms on `done` | —                 |
| Dirty node throws                | `start` → `fail` | ms on `fail` | message on `fail` |
| Dependency-failure skip          | `dep-failed`     | —            | which dep failed  |

```typescript
const emit = onProgress
  ? (e: ProgressEvent) => onProgress(e)
  : undefined;

const processNode = async (node: Node): Promise<void> => {
  const { name, kind } = node;

  // Dependency-failure skip
  for (const dep of node.deps) {
    if (failed.has(dep)) {
      failed.add(name);
      emit?.({ node: name, kind, status: "dep-failed", error: `dependency ${dep} failed` });
      execResults.set(name, { ... });
      return;
    }
  }

  // ... hash computation ...

  // Cache hit
  if (hit) {
    emit?.({ node: name, kind, status: "cached" });
    // ... existing bookkeeping ...
    return;
  }

  // Execution
  emit?.({ node: name, kind, status: "start" });
  const t0 = Date.now();
  try {
    const result = await runner(node, inputs);
    emit?.({ node: name, kind, status: "done", elapsed: Date.now() - t0 });
    // ... existing bookkeeping ...
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    emit?.({ node: name, kind, status: "fail", elapsed: Date.now() - t0, error });
    // ... existing bookkeeping ...
  }
};
```

### Step 4: Update call sites

**`src/pipeline/sync.ts`** — bundle optional params into an options bag:

```typescript
export interface SyncOptions {
  maxParallelism?: number;
  onProgress?: ProgressCallback;
}

export async function sync(
  videos: VideoInfo[],
  config: Config,
  ports: Ports,
  cache: Cache,
  opts?: SyncOptions,
): Promise<SyncResult> {
  // ...
  const results = await graph.execute(localRunner, opts);
  // ...
}
```

**`src/cli.ts`** — update the sync call:

```typescript
const results = await sync(videos, config, ports, cache, { maxParallelism: opts.parallel });
```

**`src/dag/dag.test.ts`** — update existing calls that pass `maxParallelism`:

```typescript
// Before
await g.execute(localRunner, 1);
// After
await g.execute(localRunner, { maxParallelism: 1 });
```

**`src/cli.ts`** — no progress wiring in this plan. Plan #5 will wire the callback to CLI rendering.

### Step 5: Tests in `src/dag/dag.test.ts`

**Test: emits start+done for dirty nodes**

Build a 2-node chain (root → child), execute with a callback that collects events. Assert 4 events: `[start root, done root, start child, done child]`. Verify `kind` matches what was set on the node. Verify `elapsed` is present (>= 0) on `done` events.

**Test: emits cached for cached nodes**

Execute a graph once (no callback). Execute the same graph again with a callback. Assert every event has `status: "cached"` and no `elapsed`.

**Test: emits start+fail on error, with error message and elapsed**

Add a node whose action throws `new Error("boom")`. Execute with callback. Assert `[start, fail]` for that node. Verify `fail` event has `error: "boom"` and `elapsed >= 0`.

**Test: emits dep-failed for dependency-failure skips**

Chain A → B where A throws. Execute with callback. Assert A gets `[start, fail]` and B gets `[dep-failed]` with `error` mentioning A. Verify B has no `elapsed` (it never ran).

## Non-Goals

- CLI rendering — that's plan #5
- Async callbacks — consumers buffer if needed
- Event batching or throttling — premature; the callback is just a function call
