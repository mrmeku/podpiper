# podpiper

![podpiper](podpiper.jpg)

Download YouTube channels as podcast RSS feeds, hosted on Cloudflare R2.

## Requirements

- [Bun](https://bun.sh)
- yt-dlp
- ffmpeg
- whisper-cli
- claude (Anthropic CLI)

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

R2 bucket names and public URLs are configured per channel in `src/config.ts`.

## CLI Commands

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
```

## Architecture

The project uses a **DAG-based pipeline** with four phases:

1. **Discovery** — `yt-dlp --flat-playlist` fetches the channel's video list
2. **Analysis** — `graph.analyze()` walks the DAG, computes Merkle hashes, checks caches, and returns per-node details and per-kind cached/dirty counts before any work starts
3. **DAG execution** — a readiness-loop scheduler dispatches nodes as soon as their dependencies complete, with pluggable `NodeRunner` and live progress events
4. **Publish** — uploads new files to Cloudflare R2, merges episodes into existing feed

## Output Structure

```
output/{channel}/
├── cache.json
├── feed.xml
├── artwork.jpg
├── artwork/channel_avatar.jpg
└── videos/{videoId}/
    ├── audio.mp3
    ├── audio.info.json
    ├── audio.jpg
    ├── thumbnail.jpg
    └── chapters.json
```

## Pocket Casts

Episode artwork is embedded directly in MP3 ID3 tags (Pocket Casts ignores RSS `<itunes:image>` for episodes).

To see episode artwork: Profile > Settings > Appearance > Use Episode Artwork

## Directory Layout

```
src/
├── config.ts                       # Channel config
├── types.ts                        # Domain types
├── paths.ts                        # Path helper functions
├── cli/
│   ├── cli.ts                      # CLI commands (check, sync, graph)
│   └── render.ts                   # Analysis summary, progress bars, final summary
├── dag/
│   ├── types.ts                    # BaseParams, InputsFor<P>, ActionFunc<P,R>, NodeRef<T>, Node, Cache
│   ├── graph.ts                    # DAG engine (addNode, analyze, execute)
│   ├── exec-state.ts               # Execution state machine (ready queue, dispatch, transitions)
│   ├── helpers.ts                  # computeHash, validateNoCycles, toCounts
│   └── cache.ts                    # MemCache, LocalCache, TieredCache
├── pipeline/
│   ├── define-action.ts            # defineAction helper (declarative action definitions)
│   ├── sync.ts                     # Execute graph, collect results
│   ├── graph-builder.ts            # Wire up the DAG
│   ├── discovery.ts                # Fetch video list
│   ├── check.ts                    # Diff videos against feed
│   ├── publish.ts                  # Upload to R2 and publish feed
│   └── actions/                    # DAG node implementations
│       ├── node-kind.ts            # NodeKind enum
│       ├── download.ts
│       ├── transcribe.ts
│       ├── thumbnail.ts
│       ├── chapters.ts
│       ├── chapter-prompt.ts
│       ├── summary.ts
│       ├── rss-entry.ts
│       └── artwork.ts
├── ports/
│   ├── types.ts                    # Port interfaces
│   ├── real.ts                     # Production implementations
│   ├── ytdlp.ts                    # yt-dlp wrapper
│   ├── ffmpeg.ts                   # ffmpeg wrapper
│   ├── whisper.ts                  # whisper-cli wrapper
│   ├── claude.ts                   # Claude CLI wrapper
│   ├── s3.ts                       # R2/S3 client
│   ├── mock.ts                     # Test doubles
│   ├── stub.ts                     # No-op ports (for graph viz)
│   └── memory-fs.ts                # In-memory filesystem (for tests)
├── rss/
│   ├── generate.ts                 # RSS XML builder
│   └── parse.ts                    # Feed parser + episode merging
└── graph/
    └── mermaid.ts                  # DAG visualization
```
