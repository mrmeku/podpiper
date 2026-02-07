# 06 — Temporal Scaling

## What

Add Temporal-based distributed execution: scheduler workflow, per-channel workflow, and a Temporal activity-based `NodeRunner`.

## Why

At scale (tens of thousands of channels), Temporal provides durable execution, per-channel retry, distributed workers, and scheduling. Each dirty node becomes a Temporal activity with its own retries, heartbeats, and visibility in the Temporal UI.

## Dependencies

- **NodeRunner (#3)** — the Temporal runner implements the `NodeRunner` interface, swapping in `workflow.executeActivity()` for `node.action()`

## Key Files

- New: `src/temporal/` directory
  - `scheduler-workflow.ts` — cron-triggered, fans out to channel workflows
  - `channel-workflow.ts` — sequences discover → execute → publish per channel
  - `temporal-runner.ts` — `NodeRunner` that dispatches nodes as Temporal activities
  - `activities.ts` — activity implementations wrapping node actions

## Current State

No Temporal integration exists. All execution is local and in-process via `Graph.execute()`.

## Target State

```
Scheduler Workflow (cron)
    │  spawns child workflows
    ▼
Channel Workflow (per channel)
    │  runs executor with Temporal NodeRunner
    ▼
Activities (per dirty node)
    │  each node = one Temporal activity
    ▼
Workers (distributed)
```

The executor's readiness loop runs inside the channel workflow. The workflow hosts the executor; the executor dispatches nodes via the Temporal `NodeRunner`. Cached nodes never become activities — they're pruned before Temporal is involved.

## Scope

Large, future-looking. Not needed for CLI improvements. This work stream exists to ensure the engine abstractions (NodeRunner, planning, readiness loop) support distributed execution, but implementation is deferred until scale demands it.

## Implementation Notes

- The scheduler workflow controls pacing: how many channel workflows run in parallel, YouTube API rate budget, and backpressure when workers are saturated.
- Per-channel cron is simpler but loses global pacing control — 30,000 workflows waking simultaneously creates a thundering herd.
- With distributed workers, the cache must be remote (S3, Redis). `TieredCache` already supports this — local disk is a hot layer.
- Progress events (#4) map naturally to Temporal activity heartbeats.
