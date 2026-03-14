- IMPORTANT: Skip sycophantic flattery; avoid hollow praise and empty validation. Probe my assumptions, surface bias, present counter-evidence, challenge emotional framing, and disagree openly when warranted; agreement must be earned through reason
- IMPORTANT: When I suggest non-idiomatic naming, patterns, or approaches, proactively point out the idiomatic alternative and explain why it's preferred
- When I describe what I want to build or change, start by identifying the key semantic decisions and their tradeoffs. Surface ambiguous choices as questions rather than silently picking one. Name the mental model and confirm it before writing code.

## Programming Style

1. All configuration in global variables or a single config file
2. Functions over objects wherever possible
3. Minimal comments and whitespace — only when code is genuinely hard to follow
4. Simple, straight-line code over complex abstractions
5. Use libraries, don't reimplement
6. Look up API documentation on the web rather than guessing
7. Write it, reflect on quality/simplicity/correctness, then rewrite
8. Prefer idiomatic solutions for the language/framework

## podpiper

CLI tool to download YouTube channels as podcast RSS feeds, hosted on Cloudflare R2. Bun + TypeScript (`bunx tsgo` for typechecking). Entry: `src/cli/cli.ts` (Commander: `sync`, `check`, `graph`).

### Core Semantic Decisions

Keep this section updated. When a new architectural or semantic decision is made, add it here with its rationale and implications.

**Ports and adapters.** All external tools (yt-dlp, ffmpeg, whisper-cli, claude, S3, filesystem) are behind port interfaces in `src/ports/types.ts` with real/mock/stub implementations. Logic depends only on ports, never on concrete externals. This is the testability and substitutability boundary.

**Pipeline as DAG.** Each podcast action (download, transcode, transcribe, summarize, generate RSS) is a DAG node with declared inputs/outputs. The DAG engine handles caching, parallelism, and execution order. New features are "add a node and declare edges," not "find the right place in a sequence."

**dagraph is generic.** `packages/dagraph/` is a reusable DAG execution engine with zero podcast knowledge. It exposes a context object that gets threaded through all node execution — dagraph doesn't know or care what's in it. For podpiper, that context is the ports. The bridge (`src/pipeline/actions/define-action.ts`) wraps dagraph's generic `defineAction` to type the context as `Ports`. If something feels like it belongs in dagraph, ask: does this make sense for any DAG, or just for podcasts?

**Config drives everything.** `src/config.ts` holds channel definitions with YouTube URL, R2 config, podcast metadata, optional LLM prompts. The pipeline reads config, not ad-hoc arguments scattered through the code.

### Testing

Test real logic: data transformations, parsing, merge semantics, cache invalidation, integration flows. Test doubles in `src/ports/` (mock.ts, stub.ts, memory-fs.ts).

Don't generate:

- **Mock wiring tests** that only verify a port was called with expected args
- **Null/empty guard tests** for trivially obvious behavior
- **Redundant tests** whose assertions are already covered by other tests in the suite
- **Piecemeal assertions** — build the full expected object and use a single `toEqual`

### Reference Docs

- `docs/rss-specs.md` — XML namespaces, artwork specs, Pocket Casts rules, transcript format
- `docs/adding-pipeline-action.md` — step-by-step recipe for new pipeline actions
