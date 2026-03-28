# podpiper

![podpiper](podpiper.jpg)

Convert YouTube channels into podcast RSS feeds. Under the hood, this is a **data processing pipeline** — downloading, transcoding, transcribing, summarizing, and publishing are just nodes in a dependency graph. podpiper models that graph explicitly and executes it with build-system primitives borrowed from tools like Bazel.

## Why a DAG?

Converting a YouTube video into a podcast episode is not a single step. It is a chain of dependent transformations:

```
download ──┬──> transcribe ──┬──> chapters ──> embed chapters ──┐
           ├──> thumbnail ───┤                                   │
           └─────────────────┴──> summary ──────────────────────>├──> rss entry
                                                                 │
channel avatar ──> artwork ──────────────────────────────────────┘
```

Each step depends on outputs from earlier steps. Some branches can run in parallel. Some are optional. This is a directed acyclic graph — and once you model it as one, you get caching, incrementality, and parallelism for free.

## How it works

**[dagraph](packages/dagraph/)** is a standalone DAG execution engine (a workspace package, reusable outside podpiper). It provides the primitives:

- **Content-addressed storage (CAS)** — each action writes outputs to a directory keyed by `SHA256(node name + config + sorted dependency content hashes)`. Same inputs always produce the same cache key.
- **Early cutoff** — if a node re-executes but produces identical output files, downstream nodes stay cached. Config rollbacks are cheap.
- **Event stream** — a BEP-like protocol (start, done, cached, fail, dep-failed) drives both the state machine and user-facing progress UI.
- **Pluggable schedulers** — unbounded parallelism or throttled with per-group concurrency limits (e.g., serialize GPU-bound whisper transcriptions).

**Pipeline actions** are defined using a [ports-and-adapters](https://en.wikipedia.org/wiki/Hexagonal_architecture_(software)) pattern. dagraph nodes express how they run via functions that take a context (`Ctx`). In podpiper, `Ctx` is the `Ports` interface — an aggregate of all external dependencies (yt-dlp, ffmpeg, whisper, Claude, S3, filesystem, clock). Swap real ports for fakes and you can test the entire pipeline hermetically, no network, no disk, no GPU.

Each action controls its own cache invalidation via a **config key** — a serializable value hashed into the action's cache key alongside its dependency content hashes. An LLM prompt embedded in config means changing the prompt automatically invalidates the cache. A version field gives the author a manual lever for when internal logic changes. Actions emit files to a CAS directory; dagraph hashes those files as input keys to downstream nodes, enabling early cutoff when outputs don't actually change.

**Orchestration** is decoupled from the graph. The same DAG can be executed by:

- **Local CLI** (`sync`) — in-process scheduler with tiered local+R2 cache
- **Temporal** (`serve`) — the DAG is serialized into workflow/activity definitions, distributed across worker pools with per-task-type queues and concurrency limits

Because the pipeline is modeled as data (a graph of serializable node descriptors), translating it to a new orchestrator means writing a new scheduler — not rewriting the pipeline.

## Requirements

- [Bun](https://bun.sh)
- yt-dlp
- ffmpeg
- whisper-cli (+ `ggml-large-v3-turbo.bin` model)
- claude (Anthropic CLI)

Run `bun run scripts/check-deps.ts` to verify and auto-install missing dependencies.

## Setup

```bash
bun install
```

Environment variables (`.env`):

```
R2_ACCOUNT_ID=your-account-id
R2_ACCESS_KEY_ID=your-access-key
R2_SECRET_ACCESS_KEY=your-secret-key
```

Channels are configured in `src/config.ts` with YouTube URL, R2 bucket, and podcast metadata.

## CLI

```bash
# Check for new videos not yet in feed
bun run . check <channel>

# Download, process, and publish new episodes
bun run . sync <channel>
bun run . sync <channel> -n 5       # limit to 5 videos
bun run . sync <channel> -p 4       # max parallelism
bun run . sync <channel> -c         # use browser cookies
bun run . sync <channel> -f         # skip cache, reprocess everything
bun run . sync <channel> -d         # dry-run: show plan and exit

# Visualize the DAG
bun run . graph <channel>
bun run . graph <channel> -n 3      # 3 dummy videos
bun run . graph <channel> -o dag.md # write mermaid to file

# Upload local cache to remote R2 storage
bun run . backfill <channel>

# Trigger a Temporal workflow manually
bun run . trigger <channel>

# Start Temporal workers + cron schedules
bun run . serve
```

## Architecture

See [docs/architecture.md](docs/architecture.md) for the full narrative — how the pipeline is modeled, why it mirrors build-system design, and how the same graph powers both local and distributed execution.

## Pocket Casts

Episode artwork is embedded directly in MP3 ID3 tags (Pocket Casts ignores RSS `<itunes:image>` for episodes).

To see episode artwork: Profile > Settings > Appearance > Use Episode Artwork
