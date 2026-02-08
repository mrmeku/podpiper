# 05 — CLI Progress Display

## What

Build the user-facing CLI that shows:

1. A planning summary (pre-execution breakdown of cached vs dirty nodes by kind)
2. Live per-kind progress bars during execution

## Why

Currently the CLI prints `EXEC`/`FAIL` lines after completion with no live feedback. This plan wires the planning phase (#1) and progress events (#4) — both already implemented — into a proper CLI display.

## Dependencies

- **Planning Phase (#1)** — `graph.plan()` returns `PlanningResult` with `byKind` breakdown
- **Progress Events (#4)** — `onProgress` callback in `ExecuteOptions`
- **NodeRunner (#3)** — `localRunner` injected into `execute()`

All three are already implemented.

## Key Files

- `src/dag/graph.ts` — `plan()` fixed to return clean `PlanningResult` (strip internal `hashes` field)
- `src/pipeline/sync.ts` — `sync()` changed to accept pre-built `Graph` + `PipelineRefs`
- `src/cli.ts` — sync command creates graph at CLI level, calls `plan()` + render between build and execute, `--dry-run` flag added
- New: `src/cli/render.ts` — planning summary, progress bars, final summary

## Current State

```typescript
// cli.ts sync action
const results = await sync(videos, config, ports, cache, { maxParallelism: opts.parallel });
printResults(results.results);
```

`sync()` builds the graph, executes it, and collects results in one call. The CLI can't access the graph to call `plan()` before `execute()`, and can't render anything between those phases.

## Target State

```
$ bun run src/cli.ts sync heidi

Discovering videos for heidi...
Found 47 videos

Planning: 384 nodes, 349 cached, 35 to execute

  download:          47/47 cached
  transcribe:        47/47 cached
  thumbnail:         47/47 cached
  chapters:          35/47 -- 12 to run
  summary:           35/47 -- 12 to run
  rss_entry:         37/47 -- 10 to run
  channel_avatar:     1/1  cached
  artwork:            1/1  cached

Executing...
  chapters:   ██████████████████████████░░ 10/12
  summary:    █████████████████████░░░░░░░  8/12
  rss_entry:  ████████████████░░░░░░░░░░░░  6/10

Done: 35 executed, 349 cached, 0 failed, 0 dep-failed
Publishing...
Done.
```

## Design Decisions

**Why move graph creation to the CLI:** The CLI needs to call `plan()` _before_ `execute()` to render the planning summary, and dry-run needs to skip `execute()` entirely. The fix is minimal: move `new Graph(cache)` from `sync()` to the CLI, and pass the graph to both `buildPipelineGraph` (signature unchanged) and `sync()`. No need to change `buildPipelineGraph`'s signature — it already takes a `Graph` as its first parameter. `sync()` still owns execution + result collection — it just accepts a pre-built graph instead of creating one.

**Why `cli-progress` over raw ANSI:** Multiple progress bars updating concurrently from async events is the exact problem `cli-progress`'s `MultiBar` solves — cursor management across interleaved async completions, interleaved log output, terminal resize, cleanup on stop. Rolling our own would reimplement all of that for no benefit.

**Non-TTY handling:** When `!process.stdout.isTTY`, skip `cli-progress` entirely and use a simple text renderer that logs one line per done/fail event. This keeps piped output (e.g., `sync heidi | tee log.txt`) clean — no ANSI cursor control, just straightforward log lines.

## Implementation

### Step 1: Install dependencies

```bash
bun add cli-progress picocolors && bun add -d @types/cli-progress
```

### Step 2: Fix `plan()` to return clean `PlanningResult`

`plan()` uses a reduce accumulator that includes an internal `hashes: Map<string, string>` for computing dependent node hashes. This leaks through the return value at runtime despite `PlanningResult` not declaring it. Strip `hashes` before returning:

```typescript
// graph.ts

plan(): PlanningResult {
  this.validateNoCycles();
  const { totalCounts, byKind } = this.nodes.entries().reduce<{
    hashes: Map<string, string>;
    totalCounts: NodeCounts;
    byKind: Map<string, NodeCounts>;
  }>(
    // ... existing reduce body unchanged ...
  );
  return { totalCounts, byKind };
}
```

`buildPipelineGraph` and the `graph` CLI command are unchanged — they already take a `Graph` as the first parameter.

### Step 3: Change `sync()` to accept pre-built `Graph` + `PipelineRefs`

`sync()` no longer creates the graph — it receives one. This lets the CLI call `graph.plan()` between build and execute. `PipelineRefs` is unchanged (no `graph` field added — the caller holds both separately).

```typescript
// sync.ts

import { localRunner } from "@/dag/graph";
import type { Graph } from "@/dag/graph";

export async function sync(
  graph: Graph,
  refs: PipelineRefs,
  opts?: ExecuteOptions,
): Promise<SyncResult> {
  const { publishRefs, entryRefs } = refs;
  const results = await graph.execute(localRunner, opts);
  // ... result collection logic unchanged ...
  return { uploads, results, episodes };
}
```

Tests update from `sync(videos, config, ports, cache)` to:

```typescript
const graph = new Graph(cache);
const refs = buildPipelineGraph(graph, videos, ports, config);
await sync(graph, refs, opts);
```

### Step 4: New `src/cli/render.ts`

Three functions, no classes, no state beyond what's captured in closures.

**`renderPlanSummary(plan: PlanningResult): void`**

Simple `console.log` loop over `plan.byKind`:

```typescript
export function renderPlanSummary(plan: PlanningResult): void {
  const { totalCounts, byKind } = plan;
  console.log(
    `\nPlanning: ${totalCounts.total} nodes, ${totalCounts.cached} cached, ${totalCounts.dirty} to execute\n`,
  );
  for (const [kind, counts] of byKind) {
    const label = kind.length > 20 ? kind.slice(0, 19) + "\u2026" : kind;
    const status = counts.dirty === 0 ? "cached" : `-- ${counts.dirty} to run`;
    console.log(`  ${label.padEnd(20)} ${counts.cached}/${counts.total} ${status}`);
  }
  console.log();
}
```

**`createProgressRenderer(plan: PlanningResult): { onProgress, finish }`**

Returns an `onProgress` callback and a `finish` teardown. Only creates bars for kinds with `dirty > 0`. Uses `cli-progress` `MultiBar` for concurrent multi-bar rendering.

```typescript
import { MultiBar, Presets, type SingleBar } from "cli-progress";
import pc from "picocolors";

type ProgressRenderer = { onProgress: ProgressCallback; finish: () => void };

export function createProgressRenderer(plan: PlanningResult): ProgressRenderer {
  const dirtyKinds = [...plan.byKind.entries()].filter(([, c]) => c.dirty > 0);
  if (dirtyKinds.length === 0) return { onProgress: () => {}, finish: () => {} };

  console.log("Executing...");
  if (!process.stdout.isTTY) return createTextRenderer();
  return createBarRenderer(dirtyKinds);
}

function createBarRenderer(dirtyKinds: [string, NodeCounts][]): ProgressRenderer {
  const multibar = new MultiBar(
    {
      format: "  {kind} {bar} {value}/{total}",
      barsize: 30,
      hideCursor: true,
      clearOnComplete: false,
    },
    Presets.shades_grey,
  );
  const bars = new Map<string, SingleBar>();
  for (const [kind, counts] of dirtyKinds) {
    bars.set(kind, multibar.create(counts.dirty, 0, { kind: kind.padEnd(16) }));
  }
  return {
    onProgress(event) {
      if (event.status === "done" || event.status === "fail" || event.status === "dep-failed") {
        bars.get(event.kind)?.increment();
      }
      if (event.status === "fail") {
        multibar.log(`  ${pc.red(`FAIL ${event.node}: ${event.error}`)}\n`);
      }
    },
    finish() {
      multibar.stop();
    },
  };
}

function createTextRenderer(): ProgressRenderer {
  return {
    onProgress(event) {
      if (event.status === "done") console.log(`  done ${event.node} (${event.elapsed}ms)`);
      else if (event.status === "fail") console.log(pc.red(`  FAIL ${event.node}: ${event.error}`));
    },
    finish() {},
  };
}
```

Progress increments on `done`, `fail`, and `dep-failed` — all three mean the node is terminal (failures are still progress). `cached` and `start` events are ignored. `fail` events additionally log a red-colored message above the bars via `multibar.log()`, so failures are visible in real time without disrupting bar rendering.

**TTY vs non-TTY:** When stdout is a TTY, uses `cli-progress` multi-bar. When piped, falls back to simple `console.log` per completion — one line per done/fail event, no ANSI cursor control.

**`renderFinalSummary(results: ExecResult[]): void`**

Replaces `printResults()`. Counts only — no re-printing of failure messages. The progress renderer already prints failures during execution via `multibar.log()`, which preserves logged lines after `stop()`. Dep-failed nodes are counted separately so "1 failed, 11 dep-failed" is clear vs a misleading "12 failed".

```typescript
export function renderFinalSummary(results: ExecResult[]): void {
  let exec = 0,
    cached = 0,
    failed = 0,
    depFailed = 0;
  for (const r of results) {
    if (r.status === "done") exec++;
    else if (r.status === "cached") cached++;
    else if (r.status === "fail") failed++;
    else depFailed++;
  }
  const parts = [`${exec} executed`, `${cached} cached`, `${failed} failed`];
  if (depFailed > 0) parts.push(`${depFailed} dep-failed`);
  console.log(`\nDone: ${parts.join(", ")}`);
}
```

### Step 5: Wire up CLI sync command

Replace the sync action body. Add `--dry-run` flag. Delete `printResults()`.

```typescript
program
  .command("sync")
  // ... existing options ...
  .option("-d, --dry-run", "Show plan and exit without executing")
  .action(async (channel, opts) => {
    const config = getConfig(channel);
    const ports = createRealPorts(opts);

    console.log(`Discovering videos for ${channel}...`);
    let videos = await discoverVideos(config.channelUrl, ports.ytdlp);
    console.log(`Found ${videos.length} videos`);

    if (opts.limit) {
      videos = videos.slice(0, opts.limit);
      console.log(`Processing ${videos.length} (limit=${opts.limit})`);
    }

    const cache = opts.force ? new MemCache() : new LocalCache(`${config.outputDir}/cache.json`);
    const graph = new Graph(cache);
    const refs = buildPipelineGraph(graph, videos, ports, config);

    const plan = graph.plan();
    renderPlanSummary(plan);
    if (opts.dryRun) return;

    const progress = createProgressRenderer(plan);
    const syncResult = await sync(graph, refs, {
      maxParallelism: opts.parallel,
      onProgress: progress.onProgress,
    });
    progress.finish();
    renderFinalSummary(syncResult.results);

    console.log("Publishing...");
    await publish(syncResult, config, ports.fs, ports.storage);
    console.log("Done.");
  });
```

## Non-Goals

- Testing the render module — thin wrappers around `console.log` and `cli-progress`. Verify by running the CLI.
- Throttling render calls — progress events fire per-node completion, not at high frequency.
- Customizable bar width or format — hardcode bar width and characters.
- Full color theming — `picocolors` for red failure lines only.
