# CAS + Structured Outputs

## The problem

The DAG engine constrains all action outputs to file paths:

```typescript
type Outputs = string | string[] | Record<string, string | string[]>;
```

This forces a data laundering pattern where structured data is serialized to files, passed as paths, then independently read, parsed, and cast by every consumer. `ports.fs.readJson<WhisperJson>(inputs.transcribe.json)` appears in chapters.ts, summary.ts, and rss-entry.ts. The same pattern infects the DAG-consumer boundary — `sync()` casts `r.outputs as RssEntryResult` and reads JSON files to recover data that was structured moments earlier.

The cache design is the root cause. It hashes file contents to compute content identity for early cutoff, so it requires outputs to be file paths. Fix the cache, and structured outputs become natural.

---

## Design

### Core types

```typescript
type ActionFunc<P extends BaseParams, R> = (
  params: P,
  inputs: InputsFor<P>,
) => Promise<R>;

interface NodeRef<T = unknown> {
  name: string;
  readonly _T?: T;
}

interface CacheEntry {
  value: unknown;
  contentHash: string;
}

interface Cache {
  get(key: string): CacheEntry | undefined;
  put(key: string, entry: CacheEntry): void;
  flush?: () => void | Promise<void>;
}
```

Actions return any JSON-serializable value. `NodeRef` drops the `Outputs` bound. `CacheEntry` stores the structured result directly.

### Artifact declaration

Actions that produce files declare which parts of their result are file paths via a `files` function on `ActionSpec`:

```typescript
interface ActionSpec<Ctx, P extends BaseParams, R> {
  name: (params: P) => string;
  config: string | ((params: P) => string;
  action: (ctx: Ctx) => ActionFunc<P, R>;
  files?: (result: R) => string[];
}
```

`Node` gains a corresponding type-erased `files` field. `addNode` threads the spec's typed function into it:

```typescript
interface Node {
  name: string;
  kind: string;
  deps: string[];
  config: string;
  params: BaseParams;
  action: (rawInputs: Record<string, unknown>) => Promise<unknown>;
  files: (result: unknown) => string[];
}

export function addNode<P extends BaseParams, R>(
  graph: Graph, name: string, config: string, params: P,
  action: ActionFunc<P, R>,
  files?: (result: R) => string[],
): NodeRef<R> {
  graph.add({
    name, kind: params.kind, deps: depsFromParams(params), config, params,
    action: (rawInputs) => action(params, resolveInputs<P>(params, rawInputs)),
    files: files ? (result) => files(result as R) : () => [],
  });
  return { name };
}
```

`NodeRunner` is unchanged — runners return the raw result. The executor calls `node.files(result)` separately after execution.

### Content hash

```typescript
function computeContentHash(
  result: unknown,
  files: string[],
  readFile: ReadFileFn,
): Promise<string> {
  const h = createHash("sha256");
  h.update(stableStringify(result));
  for (const path of files.sort()) {
    const content = await readFile(path);
    h.update(String(content.length));
    h.update(content);
  }
  return h.digest("hex");
}
```

The hash covers both the serialized result structure and actual file contents. Use `stableStringify` (recursive key sorting) because results include objects parsed from external JSON (yt-dlp, whisper) where key order is not guaranteed stable across versions:

```typescript
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b)))
      : val
  );
}
```

### Execution flow

```
for each ready node (topological order):
  1. actionKey = sha256(name + config + sorted dep contentHashes)
  2. cache.get(actionKey) → hit?
     yes → filePaths = node.files(cached.value)
         → re-hash files, compare to cached.contentHash
         → match → use cached.value, skip execution
         → mismatch (files deleted/modified) → fall through to execute
     no  → execute action → result R
         → filePaths = node.files(result)
         → contentHash = computeContentHash(result, filePaths, readFile)
         → cache.put(actionKey, { value: result, contentHash })
  3. pass result to downstream, store contentHash for dependents' actionKey computation
```

On cache hit, the executor verifies declared files still exist and match the stored content hash. If they don't, the node silently re-executes. This prevents stale file paths from propagating when the output directory is cleaned while the cache persists.

Early cutoff works as before: if node A re-executes but produces the same contentHash, node B's actionKey is unchanged and B gets a cache hit.

### State changes

- `ExecState.results`: `Map<string, Outputs>` → `Map<string, unknown>`
- `ExecResult.outputs` → `ExecResult.value: unknown`
- Remove `Outputs` type, `collectPaths`, `hashOutputFiles`
- Add `stableStringify`, update `computeContentHash`

---

## How each action changes

### download

```typescript
// Before: { audio: string; info: string; thumb: string }
// After:
type DownloadResult = {
  audio: string;
  info: YtDlpInfo;
  thumb: string;
};

action: (ports) => async (params) => {
  const dir = toVideoDir(params.outputDir, params.videoId);
  await ports.ytdlp.downloadVideo(dir, params.videoId);
  const info = await ports.fs.readJson<YtDlpInfo>(`${dir}/audio.info.json`);
  return { audio: `${dir}/audio.mp3`, info, thumb: `${dir}/audio.jpg` };
},
files: (r) => [r.audio, r.thumb],
```

### transcribe

```typescript
// Before: { srt: string; json: string }
// After:
type TranscribeResult = {
  srt: string;
  transcription: WhisperSegment[];
};

action: (ports) => async (params, inputs) => {
  const dir = toVideoDir(params.outputDir, params.videoId);
  await ports.whisper.transcribe(inputs.download.audio, dir);
  const whisper = await ports.fs.readJson<WhisperJson>(`${dir}/audio.en.json`);
  return { srt: `${dir}/audio.en.srt`, transcription: whisper.transcription };
},
files: (r) => [r.srt],
```

### chapters

```typescript
// Before: writes chapters.json, returns path
// After: returns Chapter[] directly, no files

action: (ports) => async (params, inputs) => {
  let result = convertYtDlpChapters(inputs.download.info.chapters);
  if (result.length === 0 && params.chapterPrompt && inputs.transcribe.transcription.length) {
    const prompt = buildChapterPrompt(inputs.transcribe.transcription, params.chapterPrompt);
    const llmResult = await ports.claude.call(prompt);
    result = parseChapterResponse(llmResult, inputs.transcribe.transcription);
  }
  return result;
},
```

Consumers access `inputs.download.info.chapters` and `inputs.transcribe.transcription` directly — typed, already parsed.

### summary

```typescript
// Before: writes summary.txt, returns path
// After: returns string directly, no files

action: (ports) => async (params, inputs) => {
  if (!inputs.transcribe.transcription.length) {
    return inputs.download.info.description ?? "";
  }
  const transcript = inputs.transcribe.transcription.map(s => s.text.trim()).join("\n");
  const prompt = `${params.summaryPrompt}\n\n...`;
  return ports.claude.call(prompt);
},
```

### thumbnail

Unchanged — already returns a file path. Adds `files: (r) => [r]`.

### rss-entry

```typescript
// Before: writes episode.json + uploads.json, returns { episode: string; uploads: string }
// After: returns structured data directly

type RssEntryResult = {
  episode: Episode;
  uploads: UploadEntry[];
};

action: (ports) => async (params, inputs) => {
  const info = inputs.download.info;
  // ... build episode and uploads from typed inputs ...
  // Write chapters JSON to disk for R2 upload
  if (inputs.chapters.length > 0) {
    const chaptersJson = JSON.stringify({ version: "1.2.0", chapters: inputs.chapters }, null, 2);
    await ports.fs.writeText(chaptersUploadPath, chaptersJson);
    uploads.push({ localPath: chaptersUploadPath, r2Key: toR2Key(params.videoId, "chapters.json") });
  }
  return { episode, uploads };
},
```

### artwork

Returns `UploadEntry[]` directly, no `files`.

### execute.ts (sync)

```typescript
// Before
const paths = r.outputs as RssEntryResult;
const episode = await fs.readJson<Episode>(paths.episode);

// After
const result = getResult(ref, resultsByName);
episodes.push(result.episode);
```

Add a typed helper to localize the cast at the DAG boundary:

```typescript
function getResult<T>(ref: NodeRef<T>, results: Map<string, ExecResult>): T | undefined {
  const r = results.get(ref.name);
  if (!r || (r.status !== "done" && r.status !== "cached")) return undefined;
  return r.value as T;
}
```

`sync()` no longer needs `fs` for reading result files.

---

## Cache size

With structured outputs, cache entries include full data (transcriptions, episodes) rather than just file paths. Rough estimate: 100 videos × ~200KB transcription ≈ 40MB. This is fine for a local JSON file. If it becomes a concern, compress the cache or split into a thin index + content blobs.

---

## Migration

### Phase 1: Engine (packages/dag)

1. Remove `Outputs` type and its constraint from `NodeRef`, `ActionFunc`, `ActionSpec`, `ActionDef`, `ExecResult`
2. Add `files` field to `Node`, `files?` parameter to `addNode`, `files?` to `ActionSpec`
3. Replace `hashOutputFiles`/`collectPaths` with `computeContentHash` + `stableStringify`
4. Add cache hit verification (re-hash files, miss on mismatch)
5. Rename `ExecResult.outputs` → `ExecResult.value`
6. Update `ExecState.results` to `Map<string, unknown>`
7. Update dag.test.ts — test early cutoff for data-only, file-only, and mixed results
8. Delete dead code: `jsonParse` (unused in dag package), `Outputs` type

### Phase 2: Actions (src/pipeline/actions)

Changing a producer's result type breaks all its consumers, so migrations are atomic per producer+consumers:

**Step 1: Leaf producers** — download (add `info: YtDlpInfo`, `files`), transcribe (add `transcription: WhisperSegment[]`, `files`), thumbnail (add `files`)

**Step 2: Mid-tier consumers** — chapters (return `Chapter[]`, access `inputs.download.info.chapters` directly), summary (return `string`, access `inputs.download.info` directly)

Steps 1 and 2 land together — chapters and summary consume both download and transcribe.

**Step 3: rss-entry** — return `{ episode, uploads }` as data, write chapters JSON for upload within the action

**Step 4: artwork** — return `UploadEntry[]` directly

### Phase 3: Consumer (src/pipeline/execute.ts)

Update `sync()` to use `getResult()` helper. Remove `fs` parameter from `sync()`.

### Cache format

Version the cache: wrap entries in `{ version: 2, entries: {...} }`. Old-format caches are ignored and recomputed on demand.

---

## Summary

| Aspect | Current | After |
|---|---|---|
| **Action return type** | File paths only (`Outputs`) | Any JSON-serializable value |
| **Data flow** | serialize → write → pass path → read → parse → cast | Pass typed values directly |
| **Content hash** | File contents only | `stableStringify(result)` + declared file contents |
| **Cache hit** | Trusts stale paths | Verifies files, re-executes on mismatch |
| **Cache entry size** | Compact (paths) | Larger (includes data) |
| **I/O between nodes** | Redundant reads per consumer | Zero |
| **Testing** | Mock filesystem for inputs/outputs | Data in, data out |
| **NodeRunner** | Unchanged | Unchanged |
