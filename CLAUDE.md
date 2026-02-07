- IMPORTANT: Skip sycophantic flattery; avoid hollow praise and empty validation. Probe my assumptions, surface bias, present counter-evidence, challenge emotional framing, and disagree openly when warranted; agreement must be earned through reason

General programming principles:

1. put all configuration in global variables that I can edit, or in a single config file.
2. use functions instead of objects wherever possible
3. prioritize low amounts of comments and whitespace. Only include comments if they are necessary to understand the code because it is really complicated
4. prefer simple, straightline code to complex abstractions
5. use libraries instead of reimplementing things from scratch
6. look up documentation for APIs on the web instead of trying to remember things from scratch
7. write the program, reflect on its quality, simplicity, correctness, and ease of modification, and then go back and write a second version

## Podcast RSS Feed Specs

Reference specifications for feed generation:

- RSS 2.0: https://www.rssboard.org/rss-specification
- Apple Podcasts: https://podcasters.apple.com/support/823-podcast-requirements
- Podcast Index namespace: https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/1.0.md

XML namespaces needed:

- `xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"`
- `xmlns:media="http://search.yahoo.com/mrss/"`

Channel-level image (need BOTH):

- `<image><url>...</url><title>...</title><link>...</link></image>` (standard RSS)
- `<itunes:image href="..."/>` (iTunes namespace)

Artwork specs:

- Minimum 1400x1400px, max 3000x3000px, square, JPEG/PNG

**Pocket Casts episode artwork (REQUIRED):**

- RSS-based `<itunes:image>` in items is DISABLED in Pocket Casts
- Must embed artwork directly in MP3 ID3 tags (yt-dlp handles this via `--embed-thumbnail`)
- User enables via: Profile > Settings > Appearance > Use Episode Artwork
- Refresh artwork: Profile > Settings > Appearance > Refresh all podcast artwork

**Thumbnail processing:**

- yt-dlp downloads thumbnails with `--write-thumbnail --convert-thumbnails jpg`
- ffmpeg pads to square and scales to 1400x1400: `pad=iw:iw:0:(oh-ih)/2:black,scale=1400:1400:flags=lanczos`

## Project

**podpiper** - CLI tool to download YouTube channels as podcast RSS feeds, hosted on Cloudflare R2.

### Architecture

- **Runtime**: Bun + TypeScript (`bunx tsgo` for typechecking)
- **Entry**: `src/cli.ts` using Commander with `sync`, `check`, and `graph` commands
- **Config**: `src/config.ts` - channel definitions with YouTube URL, R2 config, podcast metadata, optional LLM prompts
- **Execution**: DAG-based pipeline with automatic caching and parallel execution
- **Ports**: All external tools (yt-dlp, ffmpeg, whisper-cli, claude, S3, filesystem) are behind interfaces in `src/ports/types.ts`, with real/mock/stub implementations

### Core Modules

| Module                          | Purpose                                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------------------------- |
| `src/dag/graph.ts`              | DAG execution engine: topological sort, SHA256 hashing, level-parallel execution with semaphore     |
| `src/dag/cache.ts`              | MemCache (in-memory), LocalCache (JSON file), TieredCache (local + remote)                          |
| `src/pipeline/graph-builder.ts` | Wires per-video DAG: download -> {thumbnail, transcribe, chapters, summary} -> rss_entry            |
| `src/pipeline/sync.ts`          | Builds graph, executes it, collects upload entries from results                                     |
| `src/pipeline/publish.ts`       | Uploads files to R2, merges episodes into existing feed, publishes feed.xml                         |
| `src/pipeline/check.ts`         | Diffs video list against existing feed to find unprocessed videos                                   |
| `src/pipeline/discovery.ts`     | Fetches video list from YouTube via yt-dlp                                                          |
| `src/pipeline/actions/*.ts`     | Individual DAG node actions: download, transcribe, thumbnail, chapters, summary, rss-entry, artwork |
| `src/rss/generate.ts`           | Builds RSS 2.0 XML with iTunes/Media/Podcast Index namespaces                                       |
| `src/rss/parse.ts`              | Parses existing feed XML, merges episodes (dedup by id, sort by date)                               |
| `src/ports/*.ts`                | Port interfaces and implementations (ytdlp, ffmpeg, whisper, claude, s3, memory-fs)                 |

### Data Flow

1. `discoverVideos()` gets all videos via `yt-dlp --flat-playlist`
2. `buildPipelineGraph()` wires a DAG per video: download -> {thumbnail, transcribe} -> {chapters, summary} -> rss_entry
3. `sync()` executes the DAG with caching - unchanged nodes are skipped via SHA256 hash matching
4. `publish()` uploads files to R2, fetches existing feed, merges episodes, generates and uploads new feed.xml

### Output Structure

```
output/{channel}/
├── cache.json
├── feed.xml
├── artwork.jpg
├── artwork/channel_avatar.jpg
└── videos/{videoId}/
    ├── audio.mp3
    ├── audio.info.json
    ├── audio.jpg (original thumbnail)
    ├── audio.en.srt (subtitles)
    ├── thumbnail.jpg (1400x1400)
    └── chapters.json
```

### CLI Commands

- `bun run src/cli.ts check <channel>` - show videos not in feed
- `bun run src/cli.ts sync <channel> [-n N] [-c] [-p N] [-f]` - process and upload videos (`-f` skips cache)
- `bun run src/cli.ts graph <channel> [-n N] [-o path]` - visualize the DAG

### Dependencies

- yt-dlp (external) - YouTube download and metadata
- ffmpeg (external) - thumbnail processing
- whisper-cli (external) - speech-to-text transcription
- claude (external) - LLM for chapter generation and summaries
- @aws-sdk/client-s3 - R2 upload/download
- fast-xml-parser - RSS generation/parsing
- commander - CLI

### Testing

Never generate tests that fall into these categories:

1. **Mock wiring tests** — tests that only verify a dependency/port was called with expected arguments without testing any real logic. If the test would pass with _any_ implementation that calls the mock, it's testing nothing. Example: "calls ffmpeg.cropThumbnail with correct paths".
2. **Null/empty guard tests** — tests that only verify trivial behavior for null, undefined, or empty inputs (`undefined -> []`, `missing file -> null`, `[] -> []`). These are obvious from the code and not worth maintaining. Example: "returns empty for undefined", "handles both empty lists".
3. **Redundant assertion tests** — tests whose assertions are already fully covered by other tests in the same suite. If removing the test loses zero coverage of behavior, it shouldn't exist. Example: a "returns correct path" test when path is already asserted in "generates when output missing".

Tests should exercise real logic: data transformations, parsing, merge semantics, cache invalidation, integration flows. Test doubles are in `src/ports/` (mock.ts, stub.ts, memory-fs.ts).

### Coding Patterns

**File paths**: Never use inline `Bun.file()` for artifact paths. Always define helper functions like `toXxxFile(dirPath)` in the relevant module (e.g., `src/paths.ts`). This keeps paths centralized and consistent.
