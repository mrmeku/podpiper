# Plan: DAG Planning Phase

## Context

`Graph.execute()` interleaves hash computation, cache checking, and action execution. There's no point where you know what's cached vs dirty before work starts. This blocks dry-run mode and progress display.

Goal: Add a `plan()` method that walks the full DAG upfront, computes Merkle hashes, checks each against the cache, and returns per-type cached/dirty counts. `execute()` is unchanged.

## Files to Modify

| File                                 | Change                                                          |
| ------------------------------------ | --------------------------------------------------------------- |
| `src/dag/types.ts`                   | Add `kind` to `Node`, add `NodeCounts` and `PlanningResult`     |
| `src/dag/graph.ts`                   | Add `plan()` method using `node.kind`                           |
| `src/pipeline/actions/node-kind.ts`  | **New file:** `NodeKind` enum                                   |
| `src/pipeline/actions/download.ts`   | Add `kind: NodeKind.Download`                                   |
| `src/pipeline/actions/transcribe.ts` | Add `kind: NodeKind.Transcribe`                                 |
| `src/pipeline/actions/thumbnail.ts`  | Add `kind: NodeKind.Thumbnail`                                  |
| `src/pipeline/actions/chapters.ts`   | Add `kind: NodeKind.Chapters`                                   |
| `src/pipeline/actions/summary.ts`    | Add `kind: NodeKind.Summary`                                    |
| `src/pipeline/actions/rss-entry.ts`  | Add `kind: NodeKind.RssEntry`                                   |
| `src/pipeline/actions/artwork.ts`    | Add `kind: NodeKind.ChannelAvatar` and `kind: NodeKind.Artwork` |
| `src/dag/dag.test.ts`                | Add `kind` to test nodes, add `plan()` tests                    |

## 1. Add `kind` to `Node` and new types in `src/dag/types.ts`

Add `kind: string` to the `Node` interface:

```typescript
export interface Node {
  name: string;
  kind: string; // categorization for planning — use NodeKind enum values in pipeline layer
  deps: string[];
  config: string;
  action: ActionFunc;
}
```

`kind` is **not** part of the hash — it's metadata for reporting. The `name` and `config` already determine cache identity. Adding `kind` to the hash would invalidate all existing caches for no benefit.

Append after `Flushable` (line 25):

```typescript
export interface NodeCounts {
  total: number;
  cached: number;
  dirty: number;
}

export interface PlanningResult {
  totalCounts: NodeCounts;
  byKind: Map<string, NodeCounts>;
}
```

## 2. Create `NodeKind` enum and add `kind` to all call sites

**New file `src/pipeline/actions/node-kind.ts`:**

```typescript
export enum NodeKind {
  Download = "download",
  Transcribe = "transcribe",
  Thumbnail = "thumbnail",
  Chapters = "chapters",
  Summary = "summary",
  RssEntry = "rss_entry",
  ChannelAvatar = "channel_avatar",
  Artwork = "artwork",
}
```

The DAG engine (`src/dag/`) keeps `kind: string` — it's generic and doesn't import pipeline types. The `NodeKind` enum lives in the pipeline layer and provides type-safe values for each action file.

**Action file changes** — each imports `NodeKind` and adds the `kind` field:

| File                                        | `kind` value             |
| ------------------------------------------- | ------------------------ |
| `src/pipeline/actions/download.ts`          | `NodeKind.Download`      |
| `src/pipeline/actions/transcribe.ts`        | `NodeKind.Transcribe`    |
| `src/pipeline/actions/thumbnail.ts`         | `NodeKind.Thumbnail`     |
| `src/pipeline/actions/chapters.ts`          | `NodeKind.Chapters`      |
| `src/pipeline/actions/summary.ts`           | `NodeKind.Summary`       |
| `src/pipeline/actions/rss-entry.ts`         | `NodeKind.RssEntry`      |
| `src/pipeline/actions/artwork.ts` (avatar)  | `NodeKind.ChannelAvatar` |
| `src/pipeline/actions/artwork.ts` (artwork) | `NodeKind.Artwork`       |

**Test file** `src/dag/dag.test.ts` — tests don't need the enum (they're testing the DAG engine, not the pipeline). Use plain strings: `kind: "video"`, `kind: "audio"`, `kind: "feed"`, etc.

## 3. Add `plan()` method to `Graph` in `src/dag/graph.ts`

Add import of `NodeCounts`, `PlanningResult` from `./types`.

Add method to `Graph` class (before `execute()`):

```typescript
plan(): PlanningResult {
  const order = this.topoSort();
  const hashes = new Map<string, string>();
  const totalCounts: NodeCounts = { total: 0, cached: 0, dirty: 0 };
  const byKind = new Map<string, NodeCounts>();

  for (const name of order) {
    const node = this.nodes.get(name)!;
    const depHashes = new Map<string, string>();
    for (const dep of node.deps)
      depHashes.set(dep, hashes.get(dep) ?? "");
    const hash = computeHash(node, depHashes);
    hashes.set(name, hash);

    const [, hit] = this.cache.get(hash);
    totalCounts.total++;
    if (hit) totalCounts.cached++;
    else totalCounts.dirty++;

    let counts = byKind.get(node.kind);
    if (!counts) {
      counts = { total: 0, cached: 0, dirty: 0 };
      byKind.set(node.kind, counts);
    }
    counts.total++;
    if (hit) counts.cached++;
    else counts.dirty++;
  }

  return { totalCounts, byKind };
}
```

Design notes:

- **Synchronous** — `topoSort()`, `computeHash()`, and `cache.get()` are all sync
- **No side effects on graph state** — local `hashes` map, reads from `this.cache`, returns value
- **Reuses existing code** — calls `this.topoSort()` (private method) and `computeHash()` (module-level function)
- **`execute()` unchanged** — `plan()` doesn't mutate anything that `execute()` depends on

## 4. Tests in `src/dag/dag.test.ts`

Add a `describe("plan()")` block with these tests:

**Test 1: all dirty on fresh cache** — empty MemCache, 2 videos → 15 total, 0 cached, 15 dirty.

**Test 2: all cached after execute** — execute with MemCache, rebuild same graph, plan → 15 cached, 0 dirty.

**Test 3: incremental new video** — execute 2 videos, rebuild with 3 videos, plan → 14 cached (7+7 for existing), 8 dirty (7 for new + 1 feed whose deps changed).

**Test 4: byKind breakdown** — fresh cache, 2 videos, verify each kind has expected counts (e.g., `video`: {total: 2, cached: 0, dirty: 2}, `feed`: {total: 1, cached: 0, dirty: 1}).

**Test 5: plan agrees with execute** — execute 1 video, rebuild with 2 videos, call `plan()` then `execute()` on same graph, verify plan's cached/dirty counts match execute's skipped/executed counts.

## Verification

1. `bun test src/dag/dag.test.ts` — all existing + new tests pass
2. `bunx tsgo` — type check passes
