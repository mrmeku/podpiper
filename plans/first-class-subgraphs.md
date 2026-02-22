# First-Class Subgraphs in the DAG Engine

## Context

`toVideoActionName` (`kind:videoId`) and `addVideoSubgraph` compensate for the DAG package having no concept of node grouping. Every per-video action must import the naming convention, the mermaid visualization parses colons to recover groups, and there's no way to reason about or operate on a subset of the graph (e.g., re-run just one failed video's pipeline, get per-entity stats from `analyze()`).

**Goal**: Add a `scope()` primitive to `Graph` so the DAG engine understands node grouping, enabling per-scope analysis and (future) per-scope execution. As a side effect, eliminate `toVideoActionName` and make `name` optional in `ActionSpec`.

## Design

### New `GraphTarget` interface

Minimal interface that `addNode`/`defineAction` work against:

```typescript
// packages/dag/src/types.ts
interface GraphTarget {
  add(def: NodeDef): string; // returns the registered node name
}
```

### `Graph.add()` returns the registered name

Change return type from `void` to `string`. When called directly on Graph, returns `def.name` unchanged. When called through a scope wrapper, returns the prefixed name.

### `Graph.scope(prefix)` method

Returns a `GraphTarget` that auto-prefixes the node's name:

```typescript
// packages/dag/src/graph.ts
scope(prefix: string): GraphTarget {
  return {
    add: (def) => this.add({ ...def, name: `${prefix}:${def.name}` }),
  };
}
```

**Key**: deps are NOT prefixed — they're always full names. This works because `NodeRef.name` from `addNode()` already carries the full (prefixed) name, so downstream nodes referencing those refs get the correct dep names.

### `addNode()` uses `GraphTarget` and return value of `add()`

```typescript
// packages/dag/src/graph.ts
export function addNode<P extends BaseParams, R>(
  target: GraphTarget,  // was: Graph
  name: string, config: string, params: P, action: ActionFunc<P, R>,
): NodeRef<R> {
  const registeredName = target.add({ name, kind: params.kind, deps: ..., config, params, action: ... });
  return { name: registeredName };  // was: { name }
}
```

### `ActionSpec.name` becomes optional

```typescript
// packages/dag/src/define-action.ts
interface ActionSpec<Ctx, P extends BaseParams, R> {
  name?: (params: P) => string;  // defaults to (p) => p.kind
  config: string | ((params: P) => string);
  action: (ctx: Ctx) => ActionFunc<P, R>;
}
```

In `defineAction`: `const nameFn = spec.name ?? ((p: P) => p.kind);`

### Duplicate name detection with actionable error messages

With `name` defaulting to `kind`, collisions become the primary signal that the caller forgot to scope. `Graph.add()` already throws on duplicates — we enhance the error to diagnose the root cause:

**Same kind added twice at the top level** (forgot to scope):
```
Duplicate node name "download". A node with this name already exists.
  Hint: If you're adding multiple instances of the same action, wrap each group
  in graph.scope(id) to namespace them — e.g. graph.scope("abc123").
```

**Same kind added twice within the same scope** (two downloads in one scope):
```
Duplicate node name "abc123:download". A node with this name already exists in scope "abc123".
  Hint: If you need multiple "download" nodes in the same scope, provide a custom
  name function to defineAction — e.g. name: (p) => `${p.kind}_${p.variant}`.
```

**Scoped name collides with a manually-added node** (naming overlap):
```
Duplicate node name "abc123:download". A node with this name already exists.
  Hint: This may be a conflict between a scoped node (via graph.scope("abc123"))
  and a manually-named node. Check for hardcoded names that match the scope:kind pattern.
```

Implementation: `Graph.add()` inspects `def.name` to determine whether it contains a `:` (indicating it was scoped) and uses that to pick the right hint. The scope prefix is extracted via `name.slice(0, name.indexOf(":"))`.

### `ActionDef.addNode` takes `GraphTarget`

```typescript
interface ActionDef<Ctx, P extends BaseParams, R> {
  action: (ctx: Ctx) => ActionFunc<P, R>;
  addNode: (target: GraphTarget, ctx: Ctx, params: P) => NodeRef<R>;  // was: Graph
}
```

### `analyze()` gains `byScope`

```typescript
// packages/dag/src/types.ts — extend AnalysisResult
interface AnalysisResult {
  nodes: AnalyzedNode[];
  totalCounts: NodeCounts;
  byKind: Map<string, NodeCounts>;
  byScope: Map<string, NodeCounts>;  // NEW: scope prefix → counts (unscoped nodes under "" key)
}
```

Scope is derived from node names: `name.includes(":") ? name.slice(0, name.indexOf(":")) : ""`.

### Naming format change

Node names change from `download:videoId` to `videoId:download` (prefix:kind). This is the standard namespacing convention. Existing caches will invalidate (one-time, not a problem).

## Consumer changes

### Actions — delete `name`, delete `toVideoActionName`

Every per-video action changes from `name: toVideoActionName` to omitting `name` entirely (defaults to `kind`):

```typescript
// Before (download.ts):
export const download = defineActionWithPorts<DownloadParams, DownloadResult>({
  name: toVideoActionName,
  config: "...",
  action: ...
});

// After:
export const download = defineActionWithPorts<DownloadParams, DownloadResult>({
  config: "...",
  action: ...
});
```

Channel-level actions (`artwork.ts`) currently use `name: (p) => p.kind` — they can also omit `name`.

### `graph-builder.ts` — use `graph.scope()`

```typescript
function addVideoSubgraph(graph: Graph, video, ports, config) {
  const sg = graph.scope(video.id);  // NEW
  const dl = download.addNode(sg, ports, { ... });  // pass sg instead of graph
  // ... rest unchanged, all addNode calls use sg
}
```

### `mermaid.ts` — adapt grouping

Change from parsing `name.slice(colon + 1)` (kind:vid → vid) to `name.slice(0, colon)` (vid:kind → vid).

### `define-action.ts` — cleanup

Delete `toVideoActionName`. `toVideoDir` stays (it's about filesystem paths, not graph naming).

### Tests — use `scope()` and return registered names

`addItemNodes` in `dag.test.ts` uses `graph.scope(id)` and chains the returned names as deps. Node name references update from `fetch:aaa` to `aaa:fetch`.

## Files to modify

| File | Change |
|---|---|
| `packages/dag/src/types.ts` | Add `GraphTarget` interface, add `byScope` to `AnalysisResult` |
| `packages/dag/src/graph.ts` | `Graph` implements `GraphTarget`, `add()` returns `string`, add `scope()`, update `addNode()` to take `GraphTarget` and use return value |
| `packages/dag/src/define-action.ts` | `name` optional in `ActionSpec`, `GraphTarget` in `ActionDef.addNode` |
| `packages/dag/src/helpers.ts` | Add scope-extraction helper for `byScope` computation |
| `packages/dag/src/dag.test.ts` | Use `scope()`, update name references |
| `src/pipeline/actions/define-action.ts` | Delete `toVideoActionName` |
| `src/pipeline/actions/download.ts` | Remove `name` field |
| `src/pipeline/actions/transcribe.ts` | Remove `name` field |
| `src/pipeline/actions/thumbnail.ts` | Remove `name` field |
| `src/pipeline/actions/chapters.ts` | Remove `name` field |
| `src/pipeline/actions/summary.ts` | Remove `name` field |
| `src/pipeline/actions/rss-entry.ts` | Remove `name` field |
| `src/pipeline/actions/artwork.ts` | Remove `name` field (both channelAvatar and artwork) |
| `src/pipeline/graph-builder.ts` | Use `graph.scope(video.id)` |
| `src/cli/commands/graph/mermaid.ts` | Parse scope from `name.slice(0, colon)` instead of `name.slice(colon + 1)` |

## Future (not in this PR)

- `execute({ scopes: ["abc123"] })` — selective execution of specific scopes
- Nested scopes via `GraphTarget.scope()` (trivial extension)
- Per-scope failure summaries in CLI output

## Verification

1. `bunx tsgo` — type-checks clean
2. `bun test` — all tests pass
3. `bun run src/cli.ts graph <channel> -n 2` — mermaid output groups videos correctly
4. `bun run src/cli.ts sync <channel> -n 1` — end-to-end execution works
