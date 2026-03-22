# Pipeline Integration Tests

## What we test

The full sync pipeline from video list through DAG execution to R2 publish. This is the primary user-facing flow (`sync` command).

## Why

We need confidence that the pipeline:

- Produces correct artifacts (episodes, feed XML, artwork)
- Populates the content-addressed cache correctly
- Uploads the right files to R2 with correct cache headers
- Handles both code paths (with/without SRT transcript, with/without chapters)

## Test scenario

Two videos exercise both code paths:

|                       | vid_aaa       | vid_bbb                 |
| --------------------- | ------------- | ----------------------- |
| SRT transcript        | yes           | no                      |
| Chapters in info.json | 3 chapters    | none                    |
| Summary source        | LLM (has SRT) | fallback to description |

## What we assert

**FS state** — Episodes contain correct descriptions, chapters, transcript paths, and durations based on which artifacts exist.

**S3 uploads** — 8 files uploaded with correct keys and cache-control headers. vid_bbb has no SRT or chapters upload.

**Port calls** — `downloadAudio` called twice, `squareThumbnail` called twice, `claude.call` called once (only vid_aaa has SRT for summarization), `storage.getFile` called once for existing feed check.

**Episode data** — vid_aaa gets LLM summary and 3 chapters; vid_bbb falls back to info.json description with empty chapters.

**Caching** — Second run with same cache skips all 13 nodes. Only feed + artwork re-uploaded (always non-skipped in publish).

**Tiered cache** — Remote hits promote to local tier; subsequent local-only run is fully cached.
