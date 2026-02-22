# Hexagonal Architecture Audit — Fix Plan

## 1. S3 adapter silently depends on Bun filesystem

**Problem:** `ObjectStore.uploadFile` takes a `filePath: string`, forcing the S3 adapter to call `Bun.file()` directly — a hidden dependency on the Bun runtime filesystem that bypasses the `FileSystem` port.

**Fix:** Change the `ObjectStore.uploadFile` signature from `(filePath, key, bucket, cacheControl?)` to `(data: Uint8Array, key, bucket, cacheControl?)`. The caller reads the file through the `FileSystem` port and passes bytes.

**Files:**

1. `src/ports/types.ts` — change `uploadFile` signature to take `data: Uint8Array` instead of `filePath: string`
2. `src/ports/s3.ts` — remove `Bun.file()` read, accept `Uint8Array` directly
3. `src/ports/stub.ts` — update stub signature
4. `src/ports/mock.ts` — update mock signature (if needed)
5. `src/pipeline/publish.ts` — read file via `fs.readBinary()` before calling `storage.uploadFile()`
6. `src/types.ts` — `UploadEntry.localPath` is now consumed by `publish()` to read via `fs`, no type change needed
7. `src/cli/commands/sync/sync.test.ts` — update any assertions that touch upload calls
8. `src/cli/commands/check/check.test.ts` — unlikely to need changes but verify

**Side effect:** `UploadEntry` still carries `localPath` — that's fine, `publish()` uses it to read through `fs` before handing bytes to `storage`. The domain type stays the same; only the port boundary shifts.

---

## 2. `callClaude` is a bare function, not a factory

**Problem:** Every other adapter uses the factory pattern (`createRealYtdlp()`, `createRealFfmpeg()`, `createRealWhisper()`, `createS3Storage()`). The Claude adapter is a bare exported function wrapped inline in `real.ts`.

**Fix:** Convert `claude.ts` to the factory pattern.

**Files:**

1. `src/ports/claude.ts` — rename `callClaude` to a factory: `createRealLlm(model: string): Llm` that returns the port interface
2. `src/ports/real.ts` — replace inline `{ call: (prompt) => callClaude(prompt, CLAUDE_MODEL) }` with `createRealLlm(CLAUDE_MODEL)`

---

## 3. Infrastructure config mixed with domain config

**Problem:** `CLAUDE_MODEL` and `WHISPER_MODEL_PATH` are adapter-level config (which LLM model binary, which whisper model file) sitting in `config.ts` alongside domain config (channel definitions, podcast metadata). They're only consumed by `real.ts`.

**Fix:** Move these two constants into `real.ts`, the composition root where they're consumed.

**Files:**

1. `src/config.ts` — remove `CLAUDE_MODEL` and `WHISPER_MODEL_PATH`
2. `src/ports/real.ts` — define them locally (or inline)

---

## 4. Tool names leak into mermaid visualization labels

**Problem:** `NODE_LABELS` in `mermaid.ts` hardcodes adapter tool names ("yt-dlp", "whisper", "ffmpeg", "claude") in the visualization.

**Fix:** Use domain-only labels. The mermaid graph should describe *what* each node does, not *which tool* does it.

**Files:**

1. `src/cli/commands/graph/mermaid.ts` — change labels to domain terms:
   - `"yt-dlp: download"` → `"Download Audio"`
   - `"whisper: transcribe"` → `"Transcribe"`
   - `"ffmpeg: thumbnail"` → `"Crop Thumbnail"`
   - `"claude: chapters"` → `"Generate Chapters"`
   - `"claude: summary"` → `"Summarize"`
   - `"yt-dlp: avatar"` → `"Fetch Avatar"`
   - `"ffmpeg: artwork"` → `"Process Artwork"`
2. `src/cli/commands/graph/__snapshots__/graph.test.ts.snap` — update snapshot

---

## 5. `graph.ts` CLI command bypasses `FileSystem` port

**Problem:** The `graph` command uses `Bun.write()` and `Bun.spawn()` directly for file output and browser opening, while the `sync` command uses `ports.fs` for the same kind of operation.

**Fix:** This is the lowest-severity item. The `graph` command is a pure visualization utility — it doesn't touch domain data or go through the pipeline. It creates stub ports solely to build a graph structure. Using `Bun.write` for a temp HTML file in a CLI adapter is defensible.

**Decision:** Leave as-is. The graph command is a developer tool, not part of the core pipeline. Adding port injection here would be ceremony without benefit — there's no test that needs a memory filesystem for mermaid output. Document this as an accepted deviation if it bothers us later.

---

## Execution Order

1 → 3 → 2 → 4 (fix 5 is a no-op)

Do 3 first because it's trivial and unblocks 2 (moving `CLAUDE_MODEL` into `real.ts` before converting the factory). Do 1 next since it's the most impactful. Do 4 last since it's cosmetic.
