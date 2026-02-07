# 05 — CLI Progress Display

## What

Build the user-facing CLI that shows:
1. A planning summary (pre-execution breakdown of cached vs dirty nodes by type)
2. Live per-type progress bars during execution

## Why

This is the end-user goal — a better CLI interface. Currently the CLI prints `EXEC`/`FAIL` lines after completion with no live feedback.

## Dependencies

- **Planning Phase (#1)** — for the pre-execution summary (`PlanningResult.byType`)
- **Progress Events (#4)** — for live updates during execution
- **NodeRunner (#3)** — for the execution abstraction (runner is injected into `execute()`)

## Key Files

- `src/cli.ts` — current `printResults()` (lines 130–146) replaced with live rendering
- New: `src/cli/render.ts` or similar for rendering logic

## Current State

```typescript
// cli.ts lines 130-146
function printResults(results: ExecResult[]): void {
  // Prints EXEC/FAIL after everything is done
  // No live progress, no per-type breakdown
}
```

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

Done: 35 executed, 349 cached, 0 failed
Publishing...
Done.
```

## Implementation Notes

- Planning summary is a simple `console.log` loop over `PlanningResult.byType` — no terminal manipulation needed
- Live progress bars require terminal cursor manipulation (move up, overwrite lines). Consider using a library like `cli-progress` or raw ANSI escape codes.
- Only show progress bars for types that have dirty nodes — fully-cached types are shown once in the planning summary and not repeated.
- Dry-run mode (`--dry-run` flag) prints the planning summary and exits without executing.
