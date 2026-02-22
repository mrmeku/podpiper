# Orchestration Tradeoffs: Hatchet vs. Alternatives vs. DIY

## Context

podpiper is a single-user CLI tool running on a Mac Mini. It downloads YouTube channels as podcast feeds through a DAG pipeline: discover videos, download audio, transcribe, generate thumbnails/chapters/summaries, build RSS, upload to R2. The existing DAG engine handles caching (SHA256 content-addressed), level-parallel execution, and failure propagation.

The stated needs are:
1. **UI to view job execution status** — the primary motivation
2. **Retry with long delays** — e.g., "retry this node in 4 hours when my Claude quota resets"
3. **Exponential backoff** — for transient failures

The stated non-needs are:
- Distributed execution (single Mac Mini)
- Multi-tenant scheduling
- High throughput (a handful of videos per day)

---

## Option A: Hatchet

### The steel-man case

**It solves the UI problem immediately and completely.** Hatchet ships a polished dashboard with workflow run history, per-task status, real-time log streaming, latency tracking, error rates, and the ability to manually retry individual tasks from the UI. You get this out of the box. You'd spend zero time building frontend code.

**The DAG-to-Hatchet mapping is natural.** Your pipeline is already a DAG of typed tasks with explicit dependencies. Hatchet's `workflow.task({ parents: [...] })` API mirrors your existing `deps` structure almost 1:1. The plan you wrote demonstrates this — the translation from `buildPipelineGraph` to Hatchet workflow definitions is mechanical.

**Rate limiting is a first-class feature.** Hatchet's static rate limits let you declare `claude-api: 50 units / hour` and tasks automatically re-queue when exhausted. This is exactly your Claude quota scenario — you don't need to implement backoff logic, Hatchet's scheduler handles the wait-and-resume. This is arguably the single strongest technical justification beyond the UI.

**Retry semantics are declarative.** Per-task retry count + exponential backoff is configuration, not code:
```typescript
videoPipeline.task({
  name: 'transcribe',
  retries: 3,
  backoffFactor: 2.0,
  backoffMaxSeconds: 60,
  ...
});
```

**Per-task visibility gives you diagnostic power.** When a sync fails at 2 AM on a cron job, you open the dashboard and immediately see: "chapters task failed on video X at 2:17 AM, error: Claude rate limit exceeded, 2 retries attempted." This is genuinely hard to replicate with log files alone.

**Child workflow spawning handles the "N videos" fan-out.** `ctx.runChild()` per video gives each video its own workflow instance in the UI. You can see "5 of 12 videos complete" at a glance, drill into the failing one, and retry just that video.

**Cron scheduling is built-in.** Your `on: { cron: '0 8 * * *' }` replaces whatever cron/launchd setup you'd otherwise maintain.

### The honest weaknesses

**Operational overhead is real.** You're adding Docker + Postgres + Hatchet engine to a project that currently has zero infrastructure dependencies beyond yt-dlp and ffmpeg. That's a Postgres instance to keep healthy, Docker containers to keep running, and Hatchet versions to keep updated. On a Mac Mini that's also doing the actual work, this isn't free.

**The serialization boundary is a friction point.** Hatchet serializes all task inputs/outputs as JSON over gRPC. Your current actions pass file paths as typed strings within a single process. Moving to Hatchet means every inter-task value crosses a serialization boundary, and you lose the ability to pass non-serializable things (file handles, streams) between tasks. Your open question #1 in the plan is real.

**The refactoring cost is non-trivial.** Option A in your plan (extract core logic from every action to be callable both from DAG nodes and Hatchet tasks) means touching every action file and maintaining two calling conventions. This is ongoing maintenance burden, not a one-time cost.

**Long-delay retries (hours) aren't a native primitive.** Hatchet's exponential backoff is in seconds with a `backoffMaxSeconds` cap. "Retry in 4 hours" isn't expressible as a retry policy — the backoff examples show caps of 10-60 seconds. You'd need to either: (a) use rate limiting to throttle Claude tasks to your quota window, which works but is an indirect way to express "I ran out of quota", or (b) catch the error and manually re-trigger via the API/UI later. The rate limit approach is actually reasonable for the Claude case specifically, but it won't help with arbitrary "retry later" scenarios.

**You're using ~5% of what Hatchet offers.** Hatchet is designed for distributed, multi-worker, high-throughput task orchestration. You're running a single worker on a single machine processing a handful of videos. The concurrency keys, worker slots, multi-tenant rate limits — you won't use any of it.

---

## Option B: BullMQ + Bull Board

### The steel-man case

**It's the right-sized tool.** BullMQ is a job queue. You need a job queue with a UI. That's it. There's no workflow engine, no gRPC protocol, no orchestrator process. It's a library, not a platform.

**Bull Board gives you the UI you actually want.** It shows job status (waiting, active, completed, failed, delayed), lets you retry failed jobs, inspect job data and return values, and see timing. It runs as Express middleware — add 10 lines of code and you have a dashboard at `localhost:3000/queues`. No Docker, no Postgres.

**Redis is the only dependency, and it's simpler than Postgres.** A single `redis-server` process or even an embedded Redis-compatible store. No schema migrations, no vacuuming, no connection pooling tuning.

**Delayed jobs are a first-class primitive.** `queue.add('transcribe', data, { delay: 4 * 60 * 60 * 1000 })` — retry in 4 hours. This is exactly the API you described wanting. BullMQ's delayed job support is battle-tested and doesn't require rate limit workarounds.

**Exponential backoff is built-in.**
```typescript
queue.add('chapters', data, {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5000 }
});
```

**You keep your existing DAG engine.** BullMQ doesn't replace your orchestration — it wraps it. You'd enqueue a "sync-channel" job that internally calls your existing `buildPipelineGraph` + `graph.execute()`. The DAG engine handles task dependencies and caching exactly as it does today. BullMQ handles the scheduling, retry, and UI layer on top.

**The integration surface is tiny.** You're not rewriting actions or extracting dual calling conventions. You're wrapping `sync()` in a job processor. Maybe you add per-video jobs if you want finer granularity. But you can start with one queue and one job type and get value immediately.

### The honest weaknesses

**You lose per-task visibility.** BullMQ sees "sync-heidi" as one job. It doesn't know about the download/transcribe/chapters sub-tasks inside your DAG. If you want per-task status in the UI, you'd need to either: (a) create separate queues for each pipeline stage (which means reimplementing your DAG dependencies as BullMQ job dependencies — possible but ugly), or (b) write custom progress reporting from within the DAG execution callbacks.

**Redis is another process to manage.** Simpler than Postgres, but it's still a dependency your project doesn't currently have. And Redis data is ephemeral by default — you'd want persistence configured, which adds its own operational concerns.

**BullMQ doesn't give you workflow history the way Hatchet does.** Jobs are cleaned up over time. There's no "show me every sync that happened in January" unless you configure retention and query for it. The dashboard is live-operational, not historical-analytical.

**DAG-within-a-job is opaque to the scheduler.** If your DAG is 30 minutes into a 45-minute execution and the process crashes, BullMQ retries the entire job from scratch. Your cache mitigates this (completed nodes are skipped), but there's no checkpointing at the BullMQ level.

---

## Option C: Build it yourself

### The steel-man case

**Your actual requirements are extremely simple.** Strip away the buzzwords and what you need is:
1. A place to store "this run happened, here's what succeeded and failed" — that's a JSON file or SQLite database
2. A way to view that data — that's a static HTML page or a small web server
3. Retry with delay — that's `setTimeout` or a cron job
4. Exponential backoff — that's a 5-line function

**You already have 90% of the infrastructure.** Your DAG engine emits `ExecAction` events (start, success, failure, cache-hit, dep-failure, complete) with timing data. Your `renderFinalSummary` already aggregates these into a report. The gap between "print a summary to stdout" and "write a JSON log to disk" is a few lines of code.

**A minimal execution log + viewer is ~200 lines total.**
- Append each `ExecAction` event to an NDJSON log file: ~20 lines
- Serve a small web page that reads the log and renders a table: ~150 lines (or use an off-the-shelf log viewer)
- Wrap `sync` in a retry loop with configurable backoff: ~30 lines

**Zero operational dependencies added.** No Docker, no Postgres, no Redis, no gRPC, no engine process. Your Mac Mini runs the same `bun run src/cli.ts sync` it runs today, just with better logging and a viewer.

**You keep full control over the retry semantics.** "Retry in 4 hours" becomes:
```typescript
const RETRY_DELAYS = [0, 60_000, 3_600_000, 14_400_000]; // immediate, 1min, 1hr, 4hr
```
No need to learn Hatchet's rate limiting DSL or BullMQ's backoff config. You can implement exactly the behavior you want: catch a Claude quota error, check the retry-after header, schedule a retry for that exact time.

**Cron is already solved.** macOS `launchd` or a simple `setInterval` in a long-running process. You don't need Hatchet's cron scheduler for "run once a day."

**The UI can be as simple or as fancy as you want.**
- **Simplest**: `cat output/heidi/sync-log.json | jq` — you already do this
- **Simple**: serve the NDJSON log behind a small Hono/Express server, render with a table component
- **Fancy**: write execution events to SQLite, build a small dashboard with filters by channel/date/status
- **Fanciest**: push events to a Grafana-compatible format and use Grafana (free, runs locally, gives you dashboards, alerting, and history)

The point is you can match the investment to the actual need. If after a month you realize you only check the dashboard when something fails, a Slack/ntfy webhook on failure gives you 80% of the value for 5% of the effort.

### The honest weaknesses

**You're building and maintaining a UI.** Even a small one. If you want "click to retry this specific failed task" — that's a web server with an API endpoint that can trigger re-execution. That's not nothing. Hatchet gives you this button for free.

**You'll underestimate the scope.** "Just a log file and a viewer" turns into: structured error reporting, filtering by channel, time-range queries, cleanup of old logs, a way to distinguish "failed and retried successfully" from "failed permanently," progress indication for running jobs. Each is small, but they accumulate.

**No one else maintains it.** Hatchet and BullMQ have teams fixing bugs, adding features, and handling edge cases. Your DIY solution is maintained by you, and you'll be maintaining it while also maintaining the actual pipeline it's supposed to monitor.

**You lose the forcing function for good retry semantics.** When you use Hatchet or BullMQ, you're forced to declare retry policies upfront. DIY retry logic tends to be ad-hoc — a try/catch here, a hardcoded delay there — and becomes inconsistent across different failure modes over time.

---

## Summary matrix

| Concern | Hatchet | BullMQ + Bull Board | DIY |
|---|---|---|---|
| **UI quality** | Excellent, out of box | Good, out of box | Whatever you build |
| **Per-task visibility** | Yes (each DAG node is a Hatchet task) | No (DAG is opaque inside a job) | Yes (you emit the events) |
| **Retry in N hours** | Indirect (rate limits, or manual re-trigger) | Native (`delay` option) | Native (you write it) |
| **Exponential backoff** | Native | Native | Trivial to implement |
| **Operational deps** | Docker + Postgres + Hatchet engine | Redis | None |
| **Integration effort** | High (refactor all actions, dual calling convention) | Low (wrap existing sync in a job) | Low-medium (add logging + viewer) |
| **Ongoing maintenance** | Hatchet upgrades + Docker | Redis + BullMQ upgrades | Your code |
| **Cron scheduling** | Built-in | Needs external (or bull-repeatable) | launchd / setInterval |
| **Risk of over-engineering** | High | Medium | Low |
| **Risk of under-engineering** | Low | Medium | High |

## My read

Your primary need is a UI for execution visibility. Your secondary need is retry-after-delay for quota exhaustion.

Hatchet is a powerful tool, but the integration cost (refactoring every action, maintaining dual calling conventions, running Docker+Postgres) is disproportionate to the value for a single-user, single-machine CLI tool. The plan you wrote is well-designed, but it's a lot of machinery for "I want to see what happened."

BullMQ + Bull Board is the pragmatic middle ground if you decide you want a real dashboard without building one. Wrap your existing `sync()` in a job, add Bull Board, get a UI same day. You don't get per-task drill-down, but you get job status, retry, and history with minimal integration effort.

Building it yourself is the right call if you're honest about keeping the scope small. An NDJSON execution log + a failure webhook (ntfy/Slack) + launchd for scheduling covers 80% of the practical value. You can always graduate to BullMQ or Hatchet later if the DIY approach proves insufficient — and you'll know exactly which features you actually need because you'll have lived without them.
