# Typed Result Semantics: Encoding File Format Knowledge in DAG Outputs

## Context

The DAG engine constrains action outputs to file paths:

```typescript
type Outputs = string | string[] | Record<string, string | string[]>;
```

This enables content-addressed caching — the executor hashes files at those paths to determine if a node's outputs changed. It's a good constraint. But it means result types like `TranscribeResult` and `DownloadResult` are bags of untyped paths:

```typescript
type TranscribeResult = { srt: string; json: string };
type DownloadResult = { audio: string; info: string; thumb: string };
```

Every downstream consumer must independently know:
1. That `inputs.transcribe.json` is a path to a JSON file (not, say, a raw JSON string)
2. That it should be read via `ports.fs.readJson` (not `readText` or `readBinary`)
3. That it should be cast to `WhisperJson` (not some other schema)

This knowledge is scattered across every consumer. Today, `readJson<WhisperJson>(inputs.transcribe.json)` appears identically in chapters.ts, summary.ts, and rss-entry.ts. Same pattern with `readJson<YtDlpInfo>(inputs.download.info)` appearing in chapters.ts, summary.ts, and rss-entry.ts.

If the transcribe output format changes (different JSON schema, different file extension, different serialization), every consumer must be updated in lockstep. The producer knows what it wrote; the consumers shouldn't have to.

---

## Option A: Branded Path Types

### The approach

Introduce a branded string type that carries the file's content type at the type level:

```typescript
type JsonPath<T> = string & { readonly __schema: T };
type TextPath = string & { readonly __kind: "text" };

// Producer stamps the path:
function jsonPath<T>(path: string): JsonPath<T> { return path as JsonPath<T>; }

// TranscribeResult encodes the schema in its type:
type TranscribeResult = {
  srt: TextPath;
  json: JsonPath<WhisperJson>;
};

// Consumer reads without specifying the type:
function readJson<T>(fs: FileSystem, path: JsonPath<T>): Promise<T> {
  return fs.readJson<T>(path);
}

// In chapters.ts — no type annotation needed:
const whisper = await readJson(ports.fs, inputs.transcribe.json);
//    ^? WhisperJson — inferred from the branded path
```

At runtime, `JsonPath<WhisperJson>` is just a string. The branding is purely compile-time. The `Outputs` constraint is satisfied because branded strings are still strings.

### The steel-man case

**Zero runtime cost.** Branded types erase completely. No wrapper objects, no extra allocations, no serialization changes. The DAG engine, cache, and content hashing all work identically — they see plain strings.

**The DAG constraint is preserved exactly.** `Outputs` stays `string | string[] | Record<string, string | string[]>`. Branded strings satisfy this. No engine changes, no new serialization logic, no cache format migration.

**The type error appears at the right place.** If the transcribe action changes its JSON schema from `WhisperJson` to `WhisperJsonV2`, every consumer that does `readJson(ports.fs, inputs.transcribe.json)` gets a type error at their call site where they use the result — but crucially, they don't need to update their reading code. They just handle the new shape. Contrast with today: the consumer's `readJson<WhisperJson>()` cast silently succeeds even when the actual file contains something different.

**Minimal diff.** The change touches:
- A new `JsonPath<T>` / `TextPath` type (a few lines)
- A `readJson` / `readText` helper function (a few lines each)
- Each result type definition swaps `string` for `JsonPath<T>` (one-line changes)
- Each consumer swaps `ports.fs.readJson<Foo>(path)` for `readJson(ports.fs, path)` (mechanical)

**Idiomatic TypeScript.** Branded types are a well-known TS pattern (used in libraries like Effect, Zod, io-ts). Any TS developer will recognize the pattern immediately.

### The honest weaknesses

**It's a type-level-only solution to a type-level-only problem.** The actual runtime behavior doesn't change. If someone writes `ports.fs.readJson<WrongType>(inputs.transcribe.json)` bypassing the helper, nothing stops them. The branding is a convention enforced by code review, not by the runtime. You're trusting developers to use `readJson(fs, path)` instead of `fs.readJson<T>(path)`.

**Branded types are viral.** Once you brand `TranscribeResult.json` as `JsonPath<WhisperJson>`, code that handles generic `Outputs` (the DAG engine, cache layer, helpers) needs to either stay unaware of branding (fine — they see `string`) or awkwardly cast when they produce outputs from cache. The `resolveInputs` function in graph.ts returns `InputsFor<P>`, which maps deps to their output types. If `TranscribeResult.json` is `JsonPath<WhisperJson>`, the type system needs to flow that through `NodeRef<TranscribeResult>` → `InputsFor<P>` → the consumer's `inputs.transcribe.json`. This should work with the existing `InputsFor` mapped type, but it's worth verifying — branded types sometimes interact poorly with mapped types and conditional types.

**The "read" knowledge is still in the consumer.** The consumer still calls `readJson(ports.fs, path)` — they still know they're reading JSON from a file via the filesystem port. The brand tells them the schema but not the access pattern. If transcription output moved from a JSON file to, say, an API response or a database row, the consumer code would need to change.

**The names `JsonPath<WhisperJson>` can be confusing.** It looks like a path type that's parameterized by a schema, but it's really just a string at runtime. New developers might try to "read" the brand at runtime or be confused about why a string has a phantom type parameter.

---

## Option B: Expand Outputs to Support Structured Data

### The approach

Relax the DAG's `Outputs` constraint to allow structured data alongside file paths. Actions return both the file paths (for caching) and the parsed data (for consumers):

```typescript
type Outputs = string | string[] | Record<string, unknown>;

type TranscribeResult = {
  srt: string;         // file path — hashed for cache
  json: string;        // file path — hashed for cache
  transcription: WhisperSegment[];  // parsed data — passed to consumers
};

type DownloadResult = {
  audio: string;
  info: string;
  thumb: string;
  metadata: YtDlpInfo;  // parsed data — passed to consumers
};
```

The transcribe action parses the whisper JSON once and includes it in the result. Consumers access `inputs.transcribe.transcription` directly — no filesystem reads, no type casting:

```typescript
// In chapters.ts:
const segments = inputs.transcribe.transcription;
const prompt = buildChapterPrompt(segments, params.chapterPrompt);
```

The cache/hashing layer would need a way to distinguish "file paths to hash" from "structured data to store." One approach: a convention where file-path fields are explicitly declared, or a `files` sub-record:

```typescript
type TranscribeResult = {
  files: { srt: string; json: string };
  transcription: WhisperSegment[];
};
```

### The steel-man case

**It solves the problem completely, not just at the type level.** Consumers don't read files. They don't call `readJson`. They don't need the `fs` port at all for accessing dependency data. The transcribe action is the only code that knows how to parse whisper output. If the format changes, one file changes.

**It eliminates redundant I/O.** Today, the transcribe action writes a JSON file, and then chapters, summary, and rss-entry each independently read and parse that same file. That's three redundant filesystem reads and three redundant JSON parses for data that was already in memory when it was produced. With structured outputs, the data is parsed once by the producer and passed through the DAG.

**It makes the DAG edges semantically meaningful.** Today, the edge from `transcribe` to `chapters` carries the message "here are two file paths." With structured data, the edge carries "here is a transcription with segments." The dependency becomes self-documenting. You can look at `TranscribeResult` and understand what downstream nodes will receive, without reading the consumer code.

**Testing becomes dramatically simpler.** Instead of setting up a mock filesystem with JSON files at specific paths, test code passes structured data directly:

```typescript
// Before: test must write a whisper JSON file, then assert the action reads it
await ports.fs.writeText("/tmp/audio.en.json", JSON.stringify(whisperData));
const result = await chaptersAction(params, { transcribe: { srt: "...", json: "/tmp/audio.en.json" } });

// After: test passes data directly
const result = await chaptersAction(params, { transcribe: { transcription: whisperData.transcription } });
```

**The "parse once, use many" pattern is standard.** In data pipelines, intermediate results are typically passed as structured data, not as file-path references that each consumer re-reads. The current design — write to file, pass path, re-read from file — is an artifact of the caching constraint, not an intentional architectural choice.

### The honest weaknesses

**The DAG engine changes are non-trivial.** The current `Outputs` type is `string | string[] | Record<string, string | string[]>`. Content hashing works by collecting all string values and hashing the files at those paths. If outputs can now contain arbitrary structured data (arrays of objects, nested records), the hashing logic needs to distinguish "this string is a file path to hash" from "this string is data to store." This is solvable but adds real complexity to the engine.

**Cache serialization grows.** Today, cache entries store compact file paths. With structured data, the cache stores the full parsed transcription, metadata, etc. For whisper output on a long video, that's potentially megabytes of transcript data duplicated in the cache. You'd want to either: (a) only cache the file paths and re-parse on cache hit, which defeats the purpose, or (b) accept larger cache files, or (c) add a separate serialization strategy for structured vs. path data.

**It couples the DAG engine to application-level data shapes.** The DAG engine currently knows nothing about whisper transcriptions or yt-dlp metadata. It sees strings. This is a feature — the engine is generic and reusable. Once outputs contain domain objects, the serialization, hashing, and cache layers all need to handle them, even if the engine itself doesn't inspect them.

**Not all consumers need all data.** `rss-entry.ts` reads `inputs.transcribe.srt` to check if the SRT file exists (for the transcript upload), but never reads the JSON transcription. Under this approach, the full transcription data is loaded into memory and passed to rss-entry even though it doesn't use it. For large transcriptions, this is wasteful. (Counter-argument: the data is already in memory from the transcribe action; passing a reference is cheap. But if the DAG serializes/deserializes between nodes for cache purposes, it's not free.)

**It conflates "I produced these files" with "here's what's in them."** File paths in the result serve a dual purpose: they tell the cache what to hash, and they tell consumers where artifacts live (for uploading to R2, for example). `rss-entry.ts` uses `inputs.download.audio` as a path to upload, not to read. Mixing file paths and parsed data in the same result muddies this distinction.

---

## Option C: Reader Functions on Result Types

### The approach

Each result type ships with companion reader functions that encapsulate the knowledge of how to hydrate the raw file paths into domain objects. The result types stay as path records (preserving the `Outputs` constraint), but the "how to read" knowledge lives next to the "how to write" knowledge in the producer module:

```typescript
// In transcribe.ts (the producer):
export type TranscribeResult = { srt: string; json: string };

export async function readTranscription(fs: FileSystem, result: TranscribeResult): Promise<WhisperJson> {
  return fs.readJson<WhisperJson>(result.json);
}

export async function transcriptionExists(fs: FileSystem, result: TranscribeResult): Promise<boolean> {
  return fs.exists(result.json);
}

// In download.ts (the producer):
export type DownloadResult = { audio: string; info: string; thumb: string };

export async function readVideoInfo(fs: FileSystem, result: DownloadResult): Promise<YtDlpInfo> {
  return fs.readJson<YtDlpInfo>(result.info);
}
```

Consumers call the reader instead of doing raw fs operations:

```typescript
// In chapters.ts:
import { readTranscription, transcriptionExists } from "./transcribe";
import { readVideoInfo } from "./download";

const info = await readVideoInfo(ports.fs, inputs.download);
const exists = await transcriptionExists(ports.fs, inputs.transcribe);
if (exists) {
  const whisper = await readTranscription(ports.fs, inputs.transcribe);
  // ...
}
```

### The steel-man case

**It puts the knowledge exactly where it belongs — next to the producer.** The transcribe module defines the result type AND how to read it. This is the same principle behind Go's `json.Unmarshal` being in the `encoding/json` package, or a database model defining both its schema and its query methods. The producer is the authority on its own output format.

**Zero DAG engine changes.** Outputs stay as `string | string[] | Record<string, string | string[]>`. The cache, hashing, serialization — all untouched. The readers are application-level functions that sit entirely outside the DAG framework.

**It's the most incremental approach.** You can migrate one result type at a time. Add `readTranscription()` to transcribe.ts, update chapters.ts and summary.ts to call it, ship. Then do the same for `readVideoInfo()`. No big-bang refactor, no engine changes, no type system tricks.

**Readers can encapsulate complex access patterns.** Today's consumers do `exists()` + `readJson()` as a two-step dance. A reader function can encapsulate this:

```typescript
export async function readTranscriptionIfExists(
  fs: FileSystem, result: TranscribeResult
): Promise<WhisperJson | null> {
  if (!await fs.exists(result.json)) return null;
  return fs.readJson<WhisperJson>(result.json);
}
```

This removes the duplicated exists-then-read pattern from chapters.ts, summary.ts, and rss-entry.ts.

**Readers compose naturally with the port system.** The reader takes `FileSystem` as a parameter, not a concrete implementation. Tests can pass a mock filesystem. The reader doesn't close over any ambient state — it's a pure function from (fs, result) → data.

**It's discoverable.** When a developer gets a `TranscribeResult`, they can look at the transcribe module's exports to find the available readers. IDE autocomplete on the module shows `readTranscription`, `transcriptionExists`, etc. With branded types (Option A), the developer needs to know about the `readJson` helper and understand branded types. With this approach, the affordance is a plain function.

### The honest weaknesses

**It's a convention, not a constraint.** Nothing prevents a consumer from writing `ports.fs.readJson<WhisperJson>(inputs.transcribe.json)` directly, bypassing the reader. The reader functions are available but not mandatory. Over time, as new consumers are written or existing ones are modified, developers might reach for the raw path because it's shorter and more familiar. You'd need code review discipline to enforce using the readers.

**It doesn't solve the type-safety problem.** The reader function `readTranscription(fs, result)` returns `Promise<WhisperJson>`, but the `readJson<WhisperJson>` cast inside it is still unchecked. If the actual file contains something other than `WhisperJson`, you get a runtime error, not a type error. The type safety is no better than what consumers had before — it's just centralized. (Counter-argument: centralizing the cast means there's one place to add runtime validation if you ever need it.)

**The `FileSystem` port threading is noisy.** Every reader call requires passing `ports.fs` explicitly. In an action that reads from multiple dependencies, you end up with:

```typescript
const info = await readVideoInfo(ports.fs, inputs.download);
const whisper = await readTranscription(ports.fs, inputs.transcribe);
const chapters = await readChapters(ports.fs, inputs.chapters);
```

The `ports.fs` repetition is boilerplate. (Counter-argument: it's explicit about the dependency, which is consistent with the ports architecture. And it's only one extra argument per call.)

**It fragments the result type's API surface.** `TranscribeResult` is a type in `ports/types.ts`. `readTranscription` is a function in `pipeline/actions/transcribe.ts`. They're semantically coupled but physically separated. A developer looking at `TranscribeResult` in the ports file doesn't know reader functions exist unless they look at the transcribe action module. (Counter-argument: moving the type to the same file as the reader solves this — and the type arguably belongs there anyway, since it's defined by the action, not by the port.)

**The number of reader functions can proliferate.** Each result type might need: `readX`, `readXIfExists`, `readXField`, etc. For `DownloadResult` with three fields (audio, info, thumb) you might want `readVideoInfo`, `readVideoChapters` (from the info.json), `audioExists`, etc. The result type becomes a mini-module with its own API surface. (Counter-argument: you only write readers for fields that consumers actually need to interpret. `audio` and `thumb` are used as paths, not read — so they don't need readers.)

---

## Summary matrix

| Concern | A: Branded Paths | B: Structured Outputs | C: Reader Functions |
|---|---|---|---|
| **DAG engine changes** | None | Significant (Outputs type, hashing, cache) | None |
| **Runtime cost** | Zero (type-level only) | Eliminates redundant I/O | Same as today (readers do same fs calls) |
| **Type safety** | Inferred from brand — stronger | Fully typed, no casts | Centralized cast — same safety, one location |
| **Migration effort** | Small (new types + swap call sites) | Large (engine + all actions + cache) | Small (add readers, swap call sites) |
| **Enforcement** | Convention (use helper, not raw readJson) | Structural (data is in the result, no fs needed) | Convention (use reader, not raw readJson) |
| **Discoverability** | Requires knowing branded type pattern | Obvious (data is on the result object) | Good (functions exported from producer module) |
| **Cache impact** | None | Larger cache entries | None |
| **Solves the problem for** | The type checker | The runtime | The human reader |

## My read

The layering violation is real and worth fixing. The same `readJson<WhisperJson>(inputs.transcribe.json)` incantation appears in three files, and it'll appear in any future consumer too. It's a maintenance hazard: if whisper output changes, you're grepping.

Option B (structured outputs) is the most complete solution — it eliminates the problem entirely by removing the file-reading indirection. But the cost is high: the DAG engine's elegant "everything is file paths" model gets complicated, the cache grows, and the migration touches every layer. The juice isn't worth the squeeze for a problem that's fundamentally about "who knows the schema."

Option A (branded paths) is clever and zero-cost, but it's solving a developer-experience problem with type machinery that only helps if everyone consistently uses the branded-path-aware helpers. The moment someone writes `readJson<Foo>(path)` directly — which TypeScript happily allows — the branding is bypassed. It's also the most "clever" option, which tends to age poorly in small codebases where simplicity matters more than type-level rigor.

Option C (reader functions) is the least exciting but most practical. It centralizes the knowledge without changing the engine, without introducing new type patterns, and without requiring consumers to learn anything beyond "import the reader from the producer module." The enforcement is convention-based, which is a real weakness — but in a single-developer codebase, convention is usually sufficient. And the readers pull their weight beyond just fixing the layering: they can encapsulate the exists-then-read pattern that's duplicated across chapters, summary, and rss-entry today.

If this were a larger team or a public library, I'd lean toward Option A for its compile-time guarantees. For this codebase, Option C gets 90% of the value for 10% of the complexity.
