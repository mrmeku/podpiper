# @podpiper/dag

A cacheable DAG execution engine. Define nodes with typed dependencies, wire them into a graph, and execute with content-addressed caching and parallel scheduling.

## Core Idea

Everything operates on file paths. A node takes file paths in, produces file paths out (`Outputs = string | string[] | Record<string, string | string[]>`). The executor never interprets file contents — it just hashes them for cache invalidation. Type safety is added on top with `NodeRef<T>` wrappers that carry a phantom type parameter, ensuring you can't wire a `NodeRef<A>` where a `NodeRef<B>` goes.

`addNode` is the serialization boundary. It wraps a typed `ActionFunc<P, R>` with input resolution (rekeying dep names to role names) and returns a `NodeRef<R>`. Three layers result:

| Layer    | Sees                                         | Example                          |
| -------- | -------------------------------------------- | -------------------------------- |
| User     | Typed code — `ResizeParams`, `string`, etc.  | `inputs.source` (a file path)    |
| Executor | `Outputs` values keyed by node name          | `{ "fetch:img_001": "/tmp/a.jpg" }` |
| Bridge   | `resolveInputs` — rekeys node names to role names | automatic                    |

## Modules

| File               | Purpose                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------ |
| `types.ts`         | Core interfaces: `Node`, `Cache`, `CacheEntry`, `NodeRef<T>`, `ExecResult`, `Outputs`      |
| `graph.ts`         | `Graph` class: node registration, analysis, execution loop                                 |
| `exec-state.ts`    | Scheduler state machine: ready queue, inflight tracking, dependency fan-out                |
| `define-action.ts` | `defineAction` factory: binds context, params, and config into a reusable action definition |
| `cache.ts`         | `MemCache`, `FsCache` (filesystem-backed), `TieredCache` (local + remote with promotion)   |
| `helpers.ts`       | SHA256 hashing, output verification, cycle detection                                       |

## Nodes

```typescript
interface Node {
  name: string;
  kind: string;
  deps: string[];
  config: string;
  params: BaseParams;
  action: (rawInputs: Record<string, Outputs>) => Promise<Outputs>;
}
```

`params` holds everything serializable — IDs, paths, prompts, dep refs. External dependencies (filesystem, HTTP clients, CLI tools) get bound at definition time via a context object and stay outside `params`.

`kind` groups nodes by type (`"fetch"`, `"transform"`) for analysis counts and progress displays. Not part of the cache key.

`config` is a version tag plus any parameters that should invalidate cache when changed (e.g., `"v1"` or `"v2,model=gpt4"`). Included in the action key hash.

## Caching

Each node's **action key** is a SHA256 of:

- Its name
- Its config string
- Its dependencies' names and **content hashes** (sorted)

Content hashes are computed by hashing the actual file contents at the output paths. This creates a Merkle tree where changes propagate downstream, but with **early cutoff** — if a re-executed node produces files with the same content hash as before, downstream nodes stay cached even though their action key changed.

On cache hit, the executor calls `verifyOutputs` to re-hash the cached file paths. If any file is missing or corrupted, the node re-executes.

Three cache implementations:

- **`MemCache`** — in-memory `Map`. Gone when the process exits.
- **`FsCache`** — filesystem-backed cache. Stores manifests as JSON files under a base directory.
- **`TieredCache`** — checks local first, then remote. Promotes remote hits to local on read.

Implement the `Cache` interface to add your own:

```typescript
interface Cache {
  get(key: string): Promise<CacheEntry | undefined>;
  put(key: string, entry: CacheEntry): Promise<void>;
}

interface CacheEntry {
  outputs: Outputs;
  contentHash: string;
}
```

## Defining Actions

`defineAction` separates naming, cache config, and execution into a single spec:

```typescript
const resize = defineAction<Ctx, ResizeParams, string>({
  name: (p) => `resize:${p.imageId}`,
  config: "v1",
  action: (ctx) => async (params, inputs) => {
    const outPath = `${params.outputDir}/resized.jpg`;
    await ctx.imageLib.resize(inputs.source, outPath);
    return outPath;
  },
});
```

The first type parameter (`Ctx`) is the context type — whatever external dependencies your actions need. The `config` field can be a string or an object (objects are JSON-stringified). Changing config invalidates the cache for that action.

Params declare dependencies with `NodeRef<T>`:

```typescript
interface ResizeParams {
  kind: "resize";
  imageId: string;
  outputDir: string;
  deps: { source: NodeRef<string> };
}
```

`InputsFor<P>` derives the typed inputs from the `deps` record. Inside the action, `inputs.source` is the output type of the referenced node. The framework resolves inputs by rekeying from node names (`"fetch:img_001"`) to role names (`"source"`).

The returned `ActionDef` has an `addNode` method that wires everything together:

```typescript
resize.addNode(graph, ctx, params); // returns NodeRef<string>
```

## Analysis

`graph.analyze()` validates the DAG (no cycles) and returns structural info:

```typescript
const analysis = graph.analyze();
// analysis.total   → 14
// analysis.byKind  → Map { "fetch" => 2, "transform" => 5, ... }
// analysis.nodes   → Node[]
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
2. The loop pops nodes via `takeNext`, checks cache (with output verification), runs the action or skips on cache hit / dep failure
3. On completion, newly-ready children are pushed to the **front** of the queue (`unshift`). This keeps related work together — node A's fetch finishes, its dependent transform starts immediately instead of waiting behind queued fetches from other subgraphs
4. The loop continues while there's work remaining (ready > 0 or inflight > 0), dispatching up to `maxParallelism` concurrent nodes

Execution goes through a pluggable `NodeRunner`. The default `localRunner` calls `node.action(inputs)` directly. Swap in your own to dispatch work to remote workers.

Every state transition emits an `ExecAction` to the `onAction` callback:

| Action        | When                                                                         |
| ------------- | ---------------------------------------------------------------------------- |
| `start`       | Node begins executing                                                        |
| `success`     | Node completed successfully (includes outputs, contentHash, elapsed time)    |
| `failure`     | Node threw an error                                                          |
| `cache-hit`   | Node skipped — cached outputs verified intact                                |
| `dep-failure` | Node skipped because an upstream dependency failed                           |
| `complete`    | Node fully done (after success/failure/cache-hit) — triggers child promotion |

Results are a discriminated union per node:

```typescript
type ExecResult = { name: string; actionKey: string } & (
  | { status: "done"; outputs: Outputs; contentHash: string }
  | { status: "cached"; outputs: Outputs; contentHash: string }
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
  fs: { write: (path: string, data: string) => Promise<void> };
}

// 2. Define actions
interface FetchParams {
  kind: "fetch";
  url: string;
  outPath: string;
}

const fetch = defineAction<Ctx, FetchParams, string>({
  name: (p) => `fetch:${p.url}`,
  config: "v1",
  action: (ctx) => async (params) => {
    const data = await (await globalThis.fetch(params.url)).text();
    await ctx.fs.write(params.outPath, data);
    return params.outPath;
  },
});

interface TransformParams {
  kind: "transform";
  id: string;
  outPath: string;
  deps: { source: NodeRef<string> };
}

const transform = defineAction<Ctx, TransformParams, string>({
  name: (p) => `transform:${p.id}`,
  config: "v1",
  action: (ctx) => async (params, inputs) => {
    const data = await Bun.file(inputs.source).text();
    await ctx.fs.write(params.outPath, data.toUpperCase());
    return params.outPath;
  },
});

// 3. Build graph
const hashFile = async (p: string) =>
  new Bun.CryptoHasher("sha256").update(await Bun.file(p).arrayBuffer()).digest("hex");
const cache = new MemCache();
const graph = new Graph(cache, hashFile);
const ctx: Ctx = { fs: myFs };

const sourceRef = fetch.addNode(graph, ctx, {
  kind: "fetch",
  url: "https://example.com/data.json",
  outPath: "/tmp/data.json",
});
transform.addNode(graph, ctx, {
  kind: "transform",
  id: "main",
  outPath: "/tmp/transformed.json",
  deps: { source: sourceRef },
});

// 4. Execute
const results = await graph.execute();
```
