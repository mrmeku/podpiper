# Architecture / Design

## 20. `rssEntry` action does too much

Assembles episode metadata, constructs the upload manifest, formats chapters JSON for Podcast Chapters spec, checks for SRT existence, computes file size. Upload preparation should be a separate concern.

## 23. Cache manifest shares directory with action outputs

Both `manifest.json` (cache entry) and action output files live in the same CAS directory. If an action ever writes `manifest.json`, it silently corrupts the cache.

## 24. `publish()` takes `SyncResult` but only uses 2 of 3 fields

The `results` field is dead weight; the Hatchet adapter passes `results: []` as a dummy. Narrow the parameter type.

## 25. `schedule` field leaks Hatchet concerns into base config

`ChannelDef.schedule` is a cron expression only used by the `serve` command. Belongs in a Hatchet-specific wrapper, not the shared config type.

## 26. `EmbedChapters` missing from Hatchet `TASK_CONFIG`

Gets no timeout, no retries, no backoff when run through the serve path.
