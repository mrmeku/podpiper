# Architecture / Design

## 20. `rssEntry` action does too much

Assembles episode metadata, constructs the upload manifest, formats chapters JSON for Podcast Chapters spec, checks for SRT existence, computes file size. Upload preparation should be a separate concern.

