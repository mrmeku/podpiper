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
