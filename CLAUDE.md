- IMPORTANT: Skip sycophantic flattery; avoid hollow praise and empty validation. Probe my assumptions, surface bias, present counter-evidence, challenge emotional framing, and disagree openly when warranted; agreement must be earned through reason
- IMPORTANT: When I suggest non-idiomatic naming, patterns, or approaches, proactively point out the idiomatic alternative and explain why it's preferred. Teach me the idioms of the language/framework we're working in

General programming principles:

1. put all configuration in global variables that I can edit, or in a single config file.
2. use functions instead of objects wherever possible
3. prioritize low amounts of comments and whitespace. Only include comments if they are necessary to understand the code because it is really complicated
4. prefer simple, straightline code to complex abstractions
5. use libraries instead of reimplementing things from scratch
6. look up documentation for APIs on the web instead of trying to remember things from scratch
7. write the program, reflect on its quality, simplicity, correctness, and ease of modification, and then go back and write a second version
8. prefer idiomatic solutions — use the conventions, naming patterns, and standard approaches of the language/framework rather than inventing custom ones

## Project

**podpiper** - CLI tool to download YouTube channels as podcast RSS feeds, hosted on Cloudflare R2.

### Architecture

- **Runtime**: Bun + TypeScript (`bunx tsgo` for typechecking)
- **Entry**: `src/cli/cli.ts` using Commander with `sync`, `check`, and `graph` commands
- **Config**: `src/config.ts` - channel definitions with YouTube URL, R2 config, podcast metadata, optional LLM prompts
- **Execution**: DAG-based pipeline with automatic caching and parallel execution
- **Ports**: All external tools (yt-dlp, ffmpeg, whisper-cli, claude, S3, filesystem) are behind interfaces in `src/ports/types.ts`, with real/mock/stub implementations
- **DAG engine**: `packages/dagraph/` is a **reusable, generic workspace package** — it must stay free of podcast-specific concerns (intended for use outside podpiper). The bridge: `src/pipeline/actions/define-action.ts` wraps the generic `defineAction` with a `Ports`-typed context via `defineActionWithPorts`.

### Data Flow

1. `discoverVideos()` gets all videos via `yt-dlp --flat-playlist`
2. `buildPipelineGraph()` wires a DAG per video: download -> {thumbnail, transcribe} -> {chapters, summary} -> rss_entry
3. `sync()` executes the DAG with caching - unchanged nodes are skipped via SHA256 hash matching
4. `publish()` uploads files to R2, fetches existing feed, merges episodes, generates and uploads new feed.xml. Only nodes with status `"done"` (freshly executed, not cached) contribute uploads — cached episodes are assumed to already be on R2.

### Testing

Never generate tests that fall into these categories:

1. **Mock wiring tests** — tests that only verify a dependency/port was called with expected arguments without testing any real logic. If the test would pass with _any_ implementation that calls the mock, it's testing nothing. Example: "calls ffmpeg.squareThumbnail with correct paths".
2. **Null/empty guard tests** — tests that only verify trivial behavior for null, undefined, or empty inputs (`undefined -> []`, `missing file -> null`, `[] -> []`). These are obvious from the code and not worth maintaining. Example: "returns empty for undefined", "handles both empty lists".
3. **Redundant assertion tests** — tests whose assertions are already fully covered by other tests in the same suite. If removing the test loses zero coverage of behavior, it shouldn't exist. Example: a "returns correct path" test when path is already asserted in "generates when output missing".
4. **Piecemeal assertions** — never assert individual fields/keys of a structure one at a time. Build the full expected object and compare with a single `toEqual`. This gives cmp.Diff-style output on failure and makes the expected shape obvious at a glance.

Tests should exercise real logic: data transformations, parsing, merge semantics, cache invalidation, integration flows. Test doubles are in `src/ports/` (mock.ts, stub.ts, memory-fs.ts).

### Coding Patterns

**File paths**: Actions receive an `outputDir` parameter (the CAS directory `{casBaseDir}/{actionKey}/`) and write all output files there. Use `${outputDir}/filename` for output paths. Never construct paths from `config.outputDir` + video ID — the executor manages output directories.

### Cache Constraints

**Action key = hash(nodeName + config + sorted dep content hashes)**

- **Config changes invalidate cache.** If you change an ffmpeg filter or LLM prompt, bump the config string/version. If you don't, cached outputs won't re-execute.
- **Dep hashes are sorted** before hashing, so reordering the `deps` record doesn't invalidate cache.
- **`--force` vs config bump:** `--force` (CLI flag) skips cache entirely for a one-off retry. Config bumps are for when the action's logic actually changed and all future runs should re-execute.
- **Early cutoff:** If a node re-executes but produces files with identical content, the `contentHash` doesn't change. Downstream nodes hit cache. Config rollbacks are cheap.
- **Output verification:** Before accepting a cache hit, the executor verifies all output files still exist and their content hash matches. Missing or corrupted files trigger re-execution.

### RSS Feed Specs

See `docs/rss-specs.md` for XML namespace requirements, artwork specs, and Pocket Casts episode artwork rules.

### Adding a Pipeline Action

See `docs/adding-pipeline-action.md` for the step-by-step recipe.
