# @podpiper/dag

A cacheable DAG execution engine. Define nodes with typed dependencies, wire them into a graph, and execute with automatic Merkle-based caching and parallel scheduling.

## Core Idea

Everything operates on strings. A node takes strings in, returns a string out. This makes caching trivial — the executor never needs to know what your data looks like. Type safety is added on top with `NodeRef<T>` wrappers that carry a phantom type parameter. The graph-building layer uses these to ensure you can't wire a `NodeRef<A>` where a `NodeRef<B>` goes.

`addNode` is the serialization boundary. It wraps a typed action with `JSON.stringify`/`JSON.parse` and returns a `NodeRef<R>`. Three layers result:

| Layer    | Sees                                       | Example                         |
| -------- | ------------------------------------------ | ------------------------------- |
| User     | Typed code — `FetchResult`, `string`, etc. | `inputs.source.url`             |
| Executor | Raw JSON strings between nodes             | `'{"url":"…","size":42}'`       |
| Bridge   | `parseInputsFor<P>` — rekeys node names to role names and `JSON.parse`s each value | automatic |

## Modules

| File               | Purpose                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------ |
| `types.ts`         | Core interfaces: `Node`, `Cache`, `NodeRef<T>`, `ExecResult`, `InputsFor`                  |
| `graph.ts`         | `Graph` class: node registration, Merkle hashing, analysis, execution loop                 |
| `exec-state.ts`    | Scheduler state machine: ready queue, inflight tracking, dependency fan-out                |
| `define-action.ts` | `defineAction` factory: binds context, params, and serde into a reusable action definition |
| `cache.ts`         | `MemCache`, `LocalCache` (JSON file), `TieredCache` (local + remote with promotion)        |
| `helpers.ts`       | SHA256 hashing, cycle detection, node counting                                             |

## Nodes

```typescript
interface Node {
  name: string;
  kind: string;
  deps: string[];
  config: string;
  hash: string;
  params: BaseParams;
  action: (rawInputs: Record<string, string>) => Promise<string>;
}
```

`params` holds everything serializable — IDs, paths, prompts, dep refs. External dependencies (filesystem, HTTP clients, CLI tools) get bound at definition time via a context object and stay outside `params`. This means `params` can be shipped to a remote worker. The worker just needs the action registry and its own context.

`kind` groups nodes by type (`"fetch"`, `"transform"`) for analysis counts and progress displays. Not part of the cache hash.

`config` is a version tag plus any parameters that should invalidate cache when changed (e.g., `"v1"` or `"v2,model=gpt4"`). Included in the content hash.

## Caching

Each node's cache key is a SHA256 hash of:

- Its name
- Its config string
- Its dependencies' names and hashes (sorted)

A Merkle tree. Change anything upstream and all downstream hashes change automatically.

Three cache implementations:

- **`MemCache`** — in-memory `Map`. Gone when the process exits.
- **`LocalCache`** — reads/writes a JSON file on disk. Call `flush()` after execution to persist.
- **`TieredCache`** — checks local first, then remote. Promotes remote hits to local on read.

Implement the `Cache` interface to add your own:

```typescript
interface Cache {
  get(hash: string): [string, boolean];
  put(hash: string, result: string): void;
  flush?: () => void | Promise<void>;
}
```

## Defining Actions

`defineAction` separates the three concerns — naming, cache config, and execution — into a single spec:

```typescript
const resize = defineAction<Ctx, ResizeParams, string>({
  name: (p) => `resize:${p.imageId}`,
  config: "v1",
  action: (ctx) => async (params, inputs) => {
    const outPath = `${params.outputDir}/resized.jpg`;
    await ctx.imageLib.resize(inputs.source.path, outPath);
    return outPath;
  },
});
```

The first type parameter (`Ctx`) is the context type — whatever external dependencies your actions need. It's generic so the DAG engine has no opinion about what your context looks like.

Params declare dependencies with `NodeRef<T>`:

```typescript
interface ResizeParams {
  kind: "resize";
  imageId: string;
  outputDir: string;
  deps: { source: NodeRef<FetchResult> };
}
```

`InputsFor<P>` derives the typed inputs from the `deps` record. Inside the action, `inputs.source` is a `FetchResult`, not a string you parse. The framework handles serde: it parses raw JSON inputs, rekeys them from node names (`"fetch:img_001"`) to role names (`"source"`), and stringifies the return value.

The returned `ActionDef` has an `addNode` method that wires everything together:

```typescript
resize.addNode(graph, ctx, params); // returns NodeRef<string>
```

## Analysis

`graph.analyze()` walks the full DAG before execution. Computes Merkle hashes, checks each node against the cache, returns per-node dirty/cached status and per-kind aggregate counts. Powers dry-run mode without running any actions.

```typescript
const analysis = graph.analyze();
// analysis.totalCounts  → { total: 14, cached: 8, dirty: 6 }
// analysis.byKind       → Map { "fetch" => { total: 2, cached: 0, dirty: 2 }, ... }
```

## Execution

```typescript
const results = await graph.execute(localRunner, {
  maxParallelism: 4,
  onAction: (action) => {
    /* progress reporting */
  },
});
```

The executor is a readiness-loop state machine:

1. `createExecState` seeds the ready queue with zero-dep leaf nodes
2. The loop pops nodes via `takeNext`, checks cache, runs the action (or skips on cache hit / dep failure)
3. On completion, newly-ready children are pushed to the **front** of the queue (`unshift`). This keeps related work together — node A's fetch finishes, its dependent transform starts immediately instead of waiting behind queued fetches from other subgraphs
4. The loop continues while there's work remaining (ready > 0 or inflight > 0), dispatching up to `maxParallelism` concurrent nodes

Execution goes through a pluggable `NodeRunner`. The default `localRunner` calls `node.action(inputs)` directly. Swap in your own to dispatch work to remote workers.

Every state transition emits an `ExecAction` to the `onAction` callback:

| Action        | When                                                                         |
| ------------- | ---------------------------------------------------------------------------- |
| `start`       | Node begins executing                                                        |
| `success`     | Node completed successfully                                                  |
| `failure`     | Node threw an error                                                          |
| `cache-hit`   | Node skipped via cache                                                       |
| `dep-failure` | Node skipped because an upstream dependency failed                           |
| `complete`    | Node fully done (after success/failure/cache-hit) — triggers child promotion |

Results are a discriminated union per node:

```typescript
type ExecResult = { name: string; hash: string } & (
  | { status: "done"; result: string }
  | { status: "cached"; result: string }
  | { status: "fail"; error: Error }
  | { status: "dep-failed"; error: Error }
);
```

## Usage

```typescript
import { MemCache } from "@podpiper/dag/cache";
import { defineAction } from "@podpiper/dag/define-action";
import { Graph } from "@podpiper/dag/graph";
import type { NodeRef } from "@podpiper/dag/types";

// 1. Define your context type
interface Ctx {
  http: { fetch: (url: string) => Promise<string> };
}

// 2. Define actions
interface FetchParams {
  kind: "fetch";
  url: string;
}

const fetch = defineAction<Ctx, FetchParams, string>({
  name: (p) => `fetch:${p.url}`,
  config: "v1",
  action: (ctx) => async (params) => ctx.http.fetch(params.url),
});

interface TransformParams {
  kind: "transform";
  id: string;
  deps: { source: NodeRef<string> };
}

const transform = defineAction<Ctx, TransformParams, string>({
  name: (p) => `transform:${p.id}`,
  config: "v1",
  action: (_ctx) => async (_params, inputs) => inputs.source.toUpperCase(),
});

// 3. Build graph
const cache = new MemCache();
const graph = new Graph(cache);
const ctx: Ctx = { http: myHttpClient };

const sourceRef = fetch.addNode(graph, ctx, {
  kind: "fetch",
  url: "https://example.com/data.json",
});
transform.addNode(graph, ctx, {
  kind: "transform",
  id: "main",
  deps: { source: sourceRef },
});

// 4. Execute
const results = await graph.execute();
```
