# Architecture

## The problem: YouTube channels as podcasts

Converting a YouTube channel into a podcast feed sounds simple — download the audio, generate an RSS file, upload it somewhere. But each video actually requires a chain of dependent transformations: downloading media and metadata, transcribing audio, generating chapters (from YouTube metadata or via LLM), embedding chapters into ID3 tags, producing episode summaries, cropping thumbnails, and assembling everything into an RSS entry with the right files uploaded to cloud storage. Some of these steps are optional. Many can run in parallel. All of them benefit from caching — you don't want to re-transcribe a 2-hour video because the chapter prompt changed.

This is a data processing pipeline problem.

## Modeling the pipeline as a DAG

Once you see the dependency structure, the natural representation is a directed acyclic graph. Each transformation is a node. Edges represent data dependencies: transcription depends on download, chapters depend on transcription (or download metadata), the RSS entry depends on everything above it.

```
Per-video subgraph:

  download ──┬──> transcribe ──┬──> chapters ──> embed-chapters ──┐
             ├──> thumbnail ───┤                                   │
             └─────────────────┴──> summary ──────────────────────>├──> rss-entry
                                                                   │
Channel-level:                                                     │
  channel-avatar ──> artwork ──────────────────────────────────────┘
```

Each video gets its own subgraph (namespaced via `graph.subgraph(videoId)`). The full pipeline is a forest of per-video subgraphs plus shared channel-level nodes. Optional edges (transcription, summary) are conditionally wired based on channel config.

This graph is built by `src/pipeline/graph-builder.ts`. It produces a `Graph` of typed, serializable node descriptors — pure data that any execution backend can consume.

## dagraph: a build-system-inspired DAG engine

The DAG engine lives in `packages/dagraph/`, a standalone workspace package with no podcast-specific code. It is designed to be reusable. The concepts it implements are borrowed directly from build systems like Bazel.

### Content-addressed storage

Every node's cache key is computed as:

```
actionKey = SHA256(nodeName + configString + sort(dependencyContentHashes))
```

This is the same Merkle-hashing scheme build systems use. If a node's name, config, and input hashes haven't changed, its outputs are assumed valid. The outputs themselves are written to a CAS directory at `{casBaseDir}/{actionKey}/`.

Config is part of the hash intentionally. Change an ffmpeg filter or LLM prompt and the cache invalidates — no manual version bumping required for correctness (though a config version string is conventional for readability).

### Early cutoff

When a node re-executes but produces files with identical content (same SHA256), the content hash doesn't change. Downstream nodes that depend on it still hit cache. This means config rollbacks are cheap — if you revert a prompt change, the re-executed node produces the same output and nothing downstream re-runs.

### Output verification

Before accepting a cache hit, the executor verifies that all cached output files still exist on disk and their content matches the stored hash. Corrupted or deleted files trigger re-execution. This is defense against external mutations (manual file edits, incomplete previous runs).

### Event stream (BEP-like)

Execution emits a stream of typed events: `start`, `done`, `cached`, `fail`, `dep-failed`, `settled`. This mirrors the Build Event Protocol from Bazel — an event-driven interface that decouples execution from observation. The CLI's progress bars, the state machine's ready-queue advancement, and any future monitoring integration all consume the same event stream.

### Scheduling

The orchestration loop is pull-based. A `Scheduler` pulls ready nodes from an `ExecState` (which tracks the ready queue, in-flight work, and dependency fan-out) and dispatches them for execution. Two built-in schedulers:

- **Unbounded** — runs all ready nodes immediately
- **Throttled** — enforces global `maxParallelism` and per-group `concurrencyLimits` (e.g., `{ whisper: 1 }` to serialize GPU-bound transcription while parallelizing I/O-bound downloads)

Nodes declare an optional `concurrencyGroup` to opt into per-group limits.

### Tiered caching

`TieredCache` reads from a local `FsCache` first, then falls back to a remote cache (R2 via `R2Cache`). On remote hit, it populates local. Writes go to both tiers. This gives local-speed cache hits with distributed persistence — identical to Bazel's local + remote cache model.

## Anatomy of an action

dagraph lets every node express how it runs via a function. The function signature has a curried shape:

```typescript
action: (ctx: Ctx, config: C) => (params: P, inputs: Inputs, outputDir: string) => Promise<R>;
```

Three things to notice:

1. **`ctx`** — injected once when the action is registered. In podpiper this is `Ports`.
2. **`config`** — a serializable value that becomes part of the cache key. Change it and the node re-executes.
3. **`outputDir`** — a CAS directory. The action writes files here; dagraph hashes them as input keys for downstream nodes.

The return type `R` must be file paths (a string, an array of strings, or a record of them). Actions communicate with each other exclusively through files in the CAS. This is what makes them cacheable, hashable, and portable across orchestrators.

### Worked example: `chapters.ts`

The chapters action is a good showcase because it exercises every design lever at once: factory parameterization, structured config as cache key, typed dependency inputs, conditional execution, and file-based output.

```typescript
// src/pipeline/actions/chapters.ts

interface ChaptersConfig {
  version: 1;
  prompt: string | undefined;
}

export const chapters = (chapterPrompt: string | undefined) =>
  defineActionWithPorts<ChaptersParams, JsonPath<ChaptersResult>, ChaptersConfig>({
    config: { version: 1, prompt: chapterPrompt },
    action: (ports, config) => async (_params, inputs, outputDir) => {
      const info = await readJson(ports.fs, inputs.download.info);
      const ytChapters = convertYtDlpChapters(info.chapters);
      let result: ChaptersResult = { chapters: ytChapters, generated: false };
      if (ytChapters.length === 0 && config.prompt && inputs.transcribe) {
        const whisper = await readJsonIfExists(ports.fs, inputs.transcribe.json);
        if (whisper) {
          const prompt = buildChapterPrompt(whisper.transcription, config.prompt);
          const llmResult = await ports.claude.call(prompt);
          result = {
            chapters: parseChapterResponse(llmResult, whisper.transcription),
            generated: true,
          };
        }
      }
      const outputPath = `${outputDir}/chapters.json`;
      await ports.fs.writeText(outputPath, JSON.stringify(result));
      return jsonPath<ChaptersResult>(outputPath);
    },
  });
```

There is a lot packed into this. Let's unpack each design choice.

#### Factory parameterization

`chapters` is not an action — it is a function that _returns_ an action. The channel's `chapterPrompt` is captured at graph-construction time:

```typescript
chapters(config.chapterPrompt).addNode(scope, ports, { ... })
```

This is how channel-level configuration flows into the DAG. The `summary` action uses the same pattern with `summaryPrompt`. Actions that don't need parameterization (like `download` or `thumbnail`) are plain constants.

#### Config as cache key

The `config` object is deterministically serialized and hashed into the action key:

```
actionKey = SHA256(nodeName + JSON.stringify(config, sortedKeys) + sort(depContentHashes))
```

`ChaptersConfig` has two fields with different purposes:

- **`prompt`** — the channel's chapter prompt. Changing the prompt _must_ invalidate the cache because it changes the LLM's instructions and therefore the output. By including it in config, this happens automatically.
- **`version`** — a manual invalidation lever. If you refactor the action's internal logic (how it parses LLM responses, how it formats the prompt) but the config inputs haven't changed, bumping the version forces re-execution.

This is a deliberate departure from build systems. In Bazel, the action's implementation is part of the hash — change the rule and all outputs are stale. In a data pipeline, re-executing every node because you refactored a parser is wasteful. The version field gives the author control over when that cost is worth paying.

Different actions use different config strategies depending on their invalidation needs:

| Action          | Config                                            | Why                                                                                                                     |
| --------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `download`      | `"ytdlp-v1,quality=0,embed-thumb,embed-chapters"` | Simple string. Encodes the yt-dlp flags that affect output. Change quality or embedding and cache invalidates.          |
| `transcribe`    | `"whisper-v1,model=large-v3-turbo"`               | Model name in config. Switch to a different Whisper model and all transcriptions re-run.                                |
| `chapters`      | `{ version: 1, prompt: "..." }`                   | Structured object. Prompt changes invalidate automatically; version bump for logic changes.                             |
| `summary`       | `{ version: 2, prompt: "..." }`                   | Same pattern. Version was bumped to 2 when the prompt formatting changed.                                               |
| `channelAvatar` | `` `avatar-v1,date=${today}` ``                   | Date injected as daily TTL. The avatar URL is stable but the image behind it can change — this forces a daily re-fetch. |
| `embedChapters` | `"id3-chap-v1"`                                   | Rarely changes. Version bump only when the ID3 tag writing logic changes.                                               |
| `rssEntry`      | `"rss-v5"`                                        | Aggregation logic. Bumped when the episode or upload manifest schema evolves.                                           |

#### Actions emit files

The action writes `chapters.json` to `outputDir` and returns a `JsonPath<ChaptersResult>` — a phantom-typed string that tells downstream consumers both the file path and the TypeScript type of its contents. When the `embedChapters` action reads `inputs.chapters`, it gets a `JsonPath<ChaptersResult>` and can call `readJson(ports.fs, inputs.chapters)` with full type safety.

dagraph hashes all output files to compute a `contentHash`. This hash flows into the action keys of downstream nodes. If chapters re-executes but produces identical JSON (same chapters, same order), the content hash doesn't change and downstream nodes like `embedChapters` and `rssEntry` stay cached. This is the early cutoff optimization — it means you can freely re-run the pipeline after a config change and only the nodes whose outputs actually differ will cascade.

#### Intelligent short-circuiting

The action itself decides whether to do expensive work:

```typescript
if (ytChapters.length === 0 && config.prompt && inputs.transcribe) {
```

Three conditions must be true before the LLM is called: YouTube didn't provide chapters, a chapter prompt is configured for this channel, and transcription was wired as a dependency (it's optional — some channels skip transcription entirely). If any condition fails, the action writes YouTube's chapters (or an empty array) and returns. No wasted LLM calls.

This is domain logic that belongs in the action, not in the graph builder. The graph builder wires the dependency edges — it says "chapters _may_ need transcription." The action decides at runtime whether it actually does.

#### Typed dependency inputs

The params interface declares exactly what this action depends on:

```typescript
interface ChaptersParams {
  kind: typeof NodeKind.Chapters;
  videoId: string;
  deps: { download: NodeRefOf<download>; transcribe?: NodeRefOf<transcribe> };
}
```

`NodeRefOf<download>` is a type-level reference to the download action's output type. When the action runs, `inputs.download` is resolved to the actual output record (`{ audio, info, thumb }`), and `inputs.transcribe` is either the transcription result or undefined. TypeScript enforces that you can't read an output that doesn't exist in the dependency declaration.

### The hexagonal architecture

dagraph's `Ctx` type parameter is the injection point that makes all of this testable. In podpiper, `Ctx` is `Ports`:

```typescript
interface Ports {
  fs: FileSystem;
  ytdlp: YouTubeDownloader;
  ffmpeg: MediaProcessor;
  whisper: Transcriber;
  claude: Llm;
  storage: ObjectStore;
  clock: Clock;
}
```

The bridge between dagraph's generic `defineAction<Ctx>` and the application is a one-liner that pre-applies the `Ports` type:

```typescript
export const defineActionWithPorts = <P, R, C>(spec) => defineAction<Ports, P, R, C>(spec);
```

Every action is defined through this bridge. The core pipeline depends only on port interfaces — never on yt-dlp binaries, ffmpeg commands, or S3 clients directly.

### Three implementation tiers

| Tier     | Factory             | Purpose                                                                                                                    |
| -------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Real** | `createRealPorts()` | Production. Wraps yt-dlp, ffmpeg, whisper-cli, Claude CLI, S3 client, Bun filesystem                                       |
| **Mock** | `createMockPorts()` | Testing. In-memory filesystem, deterministic stubs (fake transcriptions, fixed summaries), spy-wrapped for call assertions |
| **Stub** | `createStubPorts()` | Graph visualization. Pure no-ops — every method returns empty/null. Zero I/O                                               |

Real adapters are thin wrappers (see `src/ports/`). yt-dlp, ffmpeg, and whisper are invoked via shell (`src/ports/exec.ts`). S3 uses the AWS SDK configured for Cloudflare R2. The Claude port wraps the Anthropic CLI.

### Hermetic testing

Swap real ports for mocks and the entire pipeline runs in-memory — no network, no disk, no GPU, no API calls. Tests exercise real data transformations: chapter parsing, RSS generation, episode merging, upload manifest construction. Test doubles live alongside real implementations in `src/ports/` (mock.ts, stub.ts, memory-fs.ts, memory-object-store.ts).

The pattern enables black-box testing of the pipeline: build a graph, execute it with mock ports, assert on the outputs. You verify that the right ports were called with the right arguments _and_ that their outputs were correctly transformed into downstream inputs.

### Wiring the graph

The graph builder (`src/pipeline/graph-builder.ts`) is where actions, dependencies, and channel config come together:

```typescript
const downloadRef = download.addNode(scope, ports, { kind: NodeKind.Download, videoId });
const transcribeRef = config.skipTranscribe
  ? undefined
  : transcribe.addNode(scope, ports, {
      kind: NodeKind.Transcribe,
      videoId,
      deps: { download: downloadRef },
    });
const chaptersRef = chapters(config.chapterPrompt).addNode(scope, ports, {
  kind: NodeKind.Chapters,
  videoId,
  deps: { download: downloadRef, ...(transcribeRef && { transcribe: transcribeRef }) },
});
```

The DAG is declared in code and **statically enforced by the compiler**. Each `addNode` call returns a typed `NodeRef<R>`. To declare a dependency on another node's output, you must pass its ref into the `deps` record — and the type must match. You cannot read `inputs.download.info` unless `ChaptersParams.deps` declares `download: NodeRefOf<download>`. You cannot pass a `NodeRef<string>` where a `NodeRefOf<download>` is expected.

This eliminates an entire class of footguns. There is no way to:

- Read an output from a node you didn't declare as a dependency (the key won't exist on `inputs`)
- Depend on a node with the wrong output type (TypeScript rejects the ref)
- Accidentally create a cycle by depending on yourself (refs only exist for nodes already added)

The graph builder reads like a wiring diagram because that's exactly what it is — a declarative specification of data flow. The compiler verifies the topology. dagraph validates acyclicity at execution time. Between the two, invalid graphs cannot be expressed.

## Orchestration backends

Because the pipeline is modeled as a graph of serializable node descriptors (not a hardcoded sequence of function calls), the same pipeline can be executed by different orchestrators.

### Local CLI (`sync`)

The `sync` command builds the graph in-process, analyzes it (cycle detection, cache status), and executes it with a throttled scheduler. Results are cached to local disk and optionally to R2. Progress is rendered via terminal progress bars consuming the event stream.

This is the simplest path: single process, no infrastructure dependencies beyond the external tools.

### Temporal (`serve`)

The `serve` command starts Temporal workers and registers cron schedules. The same pipeline is now distributed:

1. **`channelWorkflow`** discovers videos, spawns a child **`videoWorkflow`** per video
2. Each `videoWorkflow` receives the serialized DAG descriptor and calls `orchestrate()` (dagraph's core scheduling loop) inside the Temporal sandbox
3. For each node the scheduler dequeues, the workflow dispatches a Temporal **activity** to the appropriate task queue
4. Worker pools are sized per task type: whisper workers (1 slot, GPU-bound), claude workers (rate-limited), default workers (general I/O)

The key insight: `orchestrate()` runs identically in both contexts. In `sync`, it runs in the main process and calls `processNode()` directly. In Temporal, it runs in a deterministic V8 sandbox and dispatches activities instead. The DAG structure, caching logic, and dependency resolution are shared.

### Adding a new backend

To execute the pipeline on a new orchestrator (Kubernetes jobs, Cloud Run, an event-driven queue):

1. Serialize the graph via `graph.describe()` (strips closures, keeps node descriptors)
2. Walk the descriptors in dependency order (or use `orchestrate()` with a custom scheduler)
3. For each node, call `processNode()` — the atomic unit that handles cache lookup, action execution, and output hashing
4. Collect results and publish

The pipeline doesn't change. Only the dispatch mechanism does.
