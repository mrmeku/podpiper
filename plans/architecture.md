# Architecture / Design

## 20. `rssEntry` action does too much

Assembles episode metadata, constructs the upload manifest, formats chapters JSON for Podcast Chapters spec, checks for SRT existence, computes file size. Upload preparation should be a separate concern.

## 21. `dagraph` has hard Bun dependency

`Bun.CryptoHasher` in `helpers.ts` — Package is described as "reusable, generic" and "intended for use outside podpiper" but will crash on Node.js. No `engines` field in `package.json`. Replace with `node:crypto` (works in Bun too).

## 22. `dagraph` tests import from the host application

`dag.test.ts` imports `@/ports/memory-fs` and `@/ports/types`. The package can't be tested in isolation. Needs its own minimal `DagFs` in-memory implementation.

## 23. Cache manifest shares directory with action outputs

Both `manifest.json` (cache entry) and action output files live in the same CAS directory. If an action ever writes `manifest.json`, it silently corrupts the cache.

## 24. `publish()` takes `SyncResult` but only uses 2 of 3 fields

The `results` field is dead weight; the Hatchet adapter passes `results: []` as a dummy. Narrow the parameter type.

## 25. `schedule` field leaks Hatchet concerns into base config

`ChannelDef.schedule` is a cron expression only used by the `serve` command. Belongs in a Hatchet-specific wrapper, not the shared config type.

## 26. `EmbedChapters` missing from Hatchet `TASK_CONFIG`

Gets no timeout, no retries, no backoff when run through the serve path.
