# Podcast RSS Feed Specs

Reference specifications for feed generation:

- RSS 2.0: https://www.rssboard.org/rss-specification
- Apple Podcasts: https://podcasters.apple.com/support/823-podcast-requirements
- Podcast Index namespace: https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/1.0.md

XML namespaces needed:

- `xmlns:atom="http://www.w3.org/2005/Atom"`
- `xmlns:content="http://purl.org/rss/1.0/modules/content/"`
- `xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"`
- `xmlns:media="http://search.yahoo.com/mrss/"`
- `xmlns:podcast="https://podcastindex.org/namespace/1.0"`

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

## Transcripts

Spec: https://podcasting2.org/docs/podcast-namespace/tags/transcript

Tag: `<podcast:transcript url="..." type="..." language="..." rel="captions" />`

- `url` (required): Location of the transcript file
- `type` (required): MIME type — must be one of the values below
- `language` (optional): BCP-47 language code; defaults to feed language
- `rel` (optional): Set to `"captions"` for closed captions with timecodes

**Valid MIME types (Podcasting 2.0 spec):**

| Format | MIME type | Pocket Casts | Apple Podcasts | Podcast Addict | Podcasting 2.0 apps |
|--------|-----------|---|---|---|---|
| SRT | `application/x-subrip` | yes | yes | yes | yes |
| WebVTT | `text/vtt` | yes | yes | — | yes |
| JSON | `application/json` | yes | **no** | yes | yes |
| HTML | `text/html` | yes | — | yes | yes |
| Plain text | `text/plain` | — | **no** | **no** | yes |

**podpiper uses SRT** (`application/x-subrip`) because it has the broadest player compatibility — it's the only timed format supported by all major players including Apple Podcasts. whisper-cli also outputs a JSON file, but the Podcast Index JSON spec (`startTime`/`endTime`/`body` fields) is a different schema than whisper's output (`timestamps`/`offsets`/`text`), so using it would require a converter — and for less compatibility since Apple Podcasts doesn't support JSON transcripts.

Common mistakes: `application/srt`, `text/srt`, `text/x-subrip` are all **invalid** and will be rejected by players.
