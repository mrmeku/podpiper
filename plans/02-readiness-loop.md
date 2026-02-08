# 02 — Readiness-Loop Scheduling

## What

Replace level-by-level execution with a readiness loop that dispatches nodes as soon as all their dependencies complete, regardless of depth.

## Why

Better parallelism. In the current level-by-level approach, all nodes at depth N must complete before any node at depth N+1 starts. A readiness loop lets a node run as soon as its specific deps finish. For example, if `thumbnail:vid_a` only depends on `download:vid_a` and that download finishes first, the thumbnail starts immediately without waiting for all other downloads.

## Dependencies

None — independent engine refactor. Can be done before or after planning phase (#1).

## Scope

**Only file changed:** `src/dag/graph.ts` — `execute()` (lines 103–221), `plan()` (calls `validateNoCycles()` for cycle detection), signature changes.

Nothing else changes:

- `types.ts` — no type changes (ExecResult, Cache, Node all stay the same)
- `cache.ts` — no cache changes
- `computeHash()` — unchanged
- Pipeline code (`sync.ts`, `graph-builder.ts`, actions) — `execute()` return type and semantics are identical
- CLI — no changes

## Current State

```
topoSort → assign depths → for each depth level:
  dispatch all nodes at this depth (with semaphore)
  await Promise.all
  move to next depth
```

All nodes at depth 2 wait for ALL depth-1 nodes, even if their specific deps finished early.

**Concrete problem:** Given 10 videos, all 10 `download` nodes run (depth 0), then we wait for ALL 10 to finish before ANY `thumbnail` or `transcribe` (depth 1) starts. If vid_a's download finishes in 2 minutes but vid_j takes 20 minutes, vid_a's thumbnail sits idle for 18 minutes.

## Target State

```
build reverse-dep map → seed ready queue with zero-dep nodes
event loop:
  drain ready queue into processing slots (up to maxParallelism)
  wait for any node to complete
  on completion: check dependents, push newly-ready to front of queue
  repeat until queue empty and nothing inflight
```

## Design

The core idea: replace the depth-grouped `Promise.all` loop and semaphore with a single explicit event loop driven by a work queue.

Four concepts from the old design collapse into the loop condition, queue, and parameter:

- ~~Semaphore (acquire/release)~~ → `inflight < maxParallelism`
- ~~Completion tracking (remaining/resolveAll)~~ → `ready.length > 0 || inflight > 0`
- ~~Recursive dispatch~~ → `ready.unshift(child)`
- ~~Global `maxParallelism` + `setMaxParallelism()`~~ → `execute(maxParallelism = 4)` parameter

**Enqueue guard:** An `enqueued: Set<string>` prevents double-dispatch when multiple parents of a node complete in the same microtask batch. Without this, if node C depends on A and B and both resolve together, both `.then()` callbacks see C as ready and push it — C runs twice. The guard ensures each node enters the queue exactly once.

**Queue ordering:** Newly-ready children enter the _front_ of the queue (`unshift`), not the back. This ensures that when a download finishes, its thumbnail/transcribe nodes run before queued downloads that haven't started yet. Work that's further along the pipeline keeps moving forward.

**No recursion:** When a node completes, its `.then()` callback pushes ready children to the queue and wakes the loop. The loop picks them up on the next iteration. No `dispatch()` calling `dispatch()`, no stack growth regardless of chain depth.

## Implementation Plan

### Step 1: Build data structures (replaces topoSort + depth computation, lines 104–122)

No topo sort. Iterate `this.nodes` directly (insertion order) to build the reverse dependency map.

**Reverse dependency map** (`dependents: Map<string, Node[]>`): For each node name, which `Node` objects depend on it. The `.then()` callback gets child nodes directly — no second lookup needed.

A node is ready when `node.deps.every(d => execResults.has(d))` — we reuse the `execResults` map that already exists for the return value.

```typescript
const dependents = new Map<string, Node[]>();
for (const node of this.nodes.values()) {
  for (const dep of node.deps) {
    let list = dependents.get(dep);
    if (!list) {
      list = [];
      dependents.set(dep, list);
    }
    list.push(node);
  }
}
```

### Step 2: processNode function (replaces the level.map callback, lines 144–211)

Extract the per-node execution logic into a `processNode(node: Node): Promise<void>` function. Takes the `Node` directly — no map lookup needed. The body is nearly identical to the current level callback, minus the semaphore acquire/release:

1. Check for failed deps → mark as failed if any
2. Compute hash, check cache → store cached result if hit
3. Build inputs from dep results, call `node.action(inputs)`
4. On success: store hash + result + cache entry
5. On error: add to `failed` set

No semaphore, no finally block, no child dispatch. Just the node's own work.

```typescript
const processNode = async (node: Node): Promise<void> => {
  const { name } = node;

  for (const dep of node.deps) {
    if (failed.has(dep)) {
      failed.add(name);
      execResults.set(name, {
        name,
        hash: "",
        result: null,
        skipped: false,
        error: new Error(`skipped: dependency ${dep} failed`),
      });
      return;
    }
  }

  const depHashes = new Map<string, string>();
  for (const dep of node.deps) depHashes.set(dep, hashes.get(dep) ?? "");
  const hash = computeHash(node, depHashes);

  const [cachedResult, hit] = this.cache.get(hash);
  if (hit) {
    hashes.set(name, hash);
    results.set(name, cachedResult);
    execResults.set(name, { name, hash, result: cachedResult, skipped: true, error: null });
    return;
  }

  const inputs: Record<string, string> = {};
  for (const dep of node.deps) inputs[dep] = results.get(dep) ?? "";

  try {
    const result = await node.action(inputs);
    hashes.set(name, hash);
    results.set(name, result);
    this.cache.put(hash, result);
    execResults.set(name, { name, hash, result, skipped: false, error: null });
  } catch (e) {
    failed.add(name);
    execResults.set(name, {
      name,
      hash,
      result: null,
      skipped: false,
      error: e instanceof Error ? e : new Error(String(e)),
    });
  }
};
```

### Step 3: Event loop (replaces depth loop + semaphore, lines 124–212)

`execute()` signature changes to accept concurrency as a parameter: `async execute(maxParallelism = 4): Promise<ExecResult[]>`. The global `maxParallelism` and `setMaxParallelism()` are deleted.

The loop drains the ready queue into processing slots, waits for completions, and enqueues newly-ready children.

```typescript
const ready: Node[] = [];
const enqueued = new Set<string>();
let inflight = 0;
let wake: () => void = () => {};

// Seed with zero-dep nodes
for (const node of this.nodes.values()) {
  if (node.deps.length === 0) {
    ready.push(node);
    enqueued.add(node.name);
  }
}

while (ready.length > 0 || inflight > 0) {
  while (ready.length > 0 && inflight < maxParallelism) {
    const node = ready.shift()!;
    inflight++;
    processNode(node).then(() => {
      inflight--;
      for (const child of dependents.get(node.name) ?? []) {
        if (!enqueued.has(child.name) && child.deps.every((d) => execResults.has(d))) {
          ready.unshift(child);
          enqueued.add(child.name);
        }
      }
      wake();
    });
  }
  await new Promise<void>((r) => {
    wake = r;
  });
}
```

**How wake() works across concurrent completions:** Multiple nodes can finish between loop iterations. Their `.then()` callbacks all run as microtasks in sequence (JS is single-threaded). The first calls `wake()` which resolves the promise and schedules the loop continuation. The rest push children to `ready` before the loop runs. When the loop continues, it sees all newly-ready children and drains them.

**Empty graph:** The seed loop produces no ready nodes, so the while condition is immediately false. Execution falls through to cache flush.

### Step 4: Cache flush + return (lines 214–221)

Flush is unchanged. Return value is now built from `execResults` directly — no topo-sorted `order` to filter through.

```typescript
const isFlushable = (c: Cache): c is Cache & Flushable =>
  "flush" in c && typeof (c as Flushable).flush === "function";
if (isFlushable(this.cache)) await this.cache.flush();

return [...execResults.values()];
```

## Cycle Detection

`validateNoCycles()` stays as a private method — it already has DFS cycle detection. The caller moves from `execute()` to `plan()`: call `this.validateNoCycles()` at the top of `plan()` (discard the return value). This catches cycles at analysis time, before any work starts.

```typescript
plan(): PlanningResult {
  this.validateNoCycles();
  return this.nodes.entries().reduce<...>(/* existing reduce, unchanged */);
}
```

`execute()` no longer validates the graph. If called without `plan()`, a cycle would cause those nodes to never become ready — the loop terminates and they're absent from results. This is acceptable since the pipeline always calls `plan()` first.

## Error Propagation

Unchanged semantics. When `processNode` runs and any dep is in the `failed` set, the node is marked as failed with the same error message (`skipped: dependency ${dep} failed`). Failed nodes still complete and their `.then()` callback still checks dependents. Transitive dependents eventually become ready (all deps have `execResults` entries, including failed ones), get dispatched, detect the failed ancestor, and fail themselves. The failure propagates through the graph naturally without any special traversal.

## What Doesn't Change

| Concern         | Why unchanged                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------------- |
| `computeHash()` | Hash computation is per-node, independent of scheduling                                              |
| Return type     | Same `ExecResult[]` (order is now completion order, not topological — no caller depends on ordering) |
| Cache semantics | Same get/put/flush lifecycle                                                                         |
| Error messages  | Same `skipped: dependency ${dep} failed` string                                                      |

**Changed:**

- `plan()` — calls `this.validateNoCycles()` at the top for cycle detection. Throws `Error("cycle detected at ${name}")` on any back edge. Since `plan()` is the analysis step and runs before `execute()`, cycles are caught early.
- `validateNoCycles()` — caller moves from `execute()` to `plan()`. Method itself is unchanged.
- `maxParallelism` — moves from module-level global + setter to a parameter on `execute(maxParallelism = 4)`. The exported `maxParallelism` variable and `setMaxParallelism()` function are deleted.

## Testing

**All existing tests pass unchanged.** The refactor is behavior-preserving — same inputs produce same outputs. The 5 existing test cases (`incremental videos`, `tiered cache`, `plan()` suite, `config change rollback`) exercise caching, incremental execution, and error propagation, all of which are unaffected.

**New test — readiness ordering:** Instruments execution order to verify a dependent starts before all same-depth nodes finish.

```
A (slow: 50ms) ──→ C (fast)
B (fast: 1ms)  ──→ D (fast)
```

With level-by-level: A and B run at depth 0, both must finish, then C and D at depth 1. D waits ~50ms for A.

With readiness loop: B finishes immediately, D starts right away (while A is still running). D completes before A finishes.

```typescript
test("readiness: dependent starts as soon as its deps finish", async () => {
  const cache = new MemCache();
  const g = new Graph(cache);
  const log: string[] = [];

  g.add({
    name: "A",
    kind: "slow",
    deps: [],
    config: "a",
    action: async () => {
      await Bun.sleep(50);
      log.push("A");
      return "a";
    },
  });
  g.add({
    name: "B",
    kind: "fast",
    deps: [],
    config: "b",
    action: async () => {
      log.push("B");
      return "b";
    },
  });
  g.add({
    name: "C",
    kind: "dep",
    deps: ["A"],
    config: "c",
    action: async () => {
      log.push("C");
      return "c";
    },
  });
  g.add({
    name: "D",
    kind: "dep",
    deps: ["B"],
    config: "d",
    action: async () => {
      log.push("D");
      return "d";
    },
  });

  await g.execute();
  // D should execute before A completes (and thus before C)
  expect(log.indexOf("D")).toBeLessThan(log.indexOf("A"));
});
```

**New test — queue priority (children before siblings):** Verifies that when a download finishes, its downstream nodes run before other queued downloads.

```typescript
test("children of completed nodes run before queued siblings", async () => {
  const cache = new MemCache();
  const g = new Graph(cache);
  const log: string[] = [];

  g.add({
    name: "D1",
    kind: "download",
    deps: [],
    config: "d1",
    action: async () => {
      log.push("D1");
      return "d1";
    },
  });
  g.add({
    name: "D2",
    kind: "download",
    deps: [],
    config: "d2",
    action: async () => {
      log.push("D2");
      return "d2";
    },
  });
  g.add({
    name: "T1",
    kind: "thumb",
    deps: ["D1"],
    config: "t1",
    action: async () => {
      log.push("T1");
      return "t1";
    },
  });

  await g.execute(1); // force serial to make ordering deterministic
  // T1 should run before D2 because D1's child gets queue priority
  expect(log).toEqual(["D1", "T1", "D2"]);
});
```

## Risks

- **Wake coalescing:** If multiple nodes complete in the same microtask batch, only the first `wake()` call resolves the promise. The others are no-ops on the same resolve function. This is fine — all their children are pushed to `ready` before the loop resumes, so the loop sees all of them. No work is lost.
- **Unhandled rejection from processNode:** `processNode` has its own try/catch, so errors are captured in `execResults`. The `.then()` callback only does synchronous queue operations (Map.get/set, array push) which can't throw. No unhandled rejections possible.
