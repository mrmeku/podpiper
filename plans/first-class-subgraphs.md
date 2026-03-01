# First-Class Subgraphs in the DAG Engine

## Context

`toVideoActionName` (`kind:videoId`) and `addVideoSubgraph` compensate for the DAG package having no concept of node grouping. Every per-video action must import the naming convention, the mermaid visualization parses colons to recover groups, and there's no way to reason about or operate on a subset of the graph (e.g., re-run just one failed video's pipeline, get per-entity stats from `analyze()`).

**Goal**: Add a `scope()` primitive to `Graph` so the DAG engine understands node grouping, enabling per-scope analysis and (future) per-scope execution. As a side effect, eliminate `toVideoActionName` and make `name` optional in `ActionSpec`.

## Design

### New `GraphTarget` interface

Minimal interface that `addNode`/`defineAction` work against:

```typescript
// packages/dagraph/src/types.ts
interface GraphTarget {
  add(def: Node): string; // returns the registered node name
}
```

### `Graph.add()` returns the registered name

Change return type from `void` to `string`. When called directly on Graph, returns `def.name` unchanged. When called through a scope wrapper, returns the prefixed name.

### `Graph.scope(prefix)` method

Returns a `GraphTarget` that auto-prefixes the node's name:

```typescript
// packages/dagraph/src/graph.ts
scope(prefix: string): GraphTarget {
  return {
    add: (def) => this.add({ ...def, name: `${prefix}:${def.name}` }),
  };
}
```

**Key**: deps are NOT prefixed — they're always full names. This works because `NodeRef.name` from `addNode()` already carries the full (prefixed) name, so downstream nodes referencing those refs get the correct dep names.

### `addNode()` uses `GraphTarget` and return value of `add()`

```typescript
// packages/dagraph/src/graph.ts
export function addNode<P extends BaseParams, R extends Outputs>({
  action,
  concurrencyGroup,
  config,
  target,  // was: graph
  name,
  params,
}: {
  target: GraphTarget;  // was: graph: Graph
  name: string;
  config: string;
  concurrencyGroup?: string;
  params: P;
  action: ActionFunc<P, R>;
}): NodeRef<R> {
  const registeredName = target.add({
    name, kind: params.kind, deps: depsFromParams(params), config,
    ...(concurrencyGroup && { concurrencyGroup }),
    params,
    action: (rawInputs, outputDir) => action(params, resolveInputs<P>(params, rawInputs), outputDir),
  });
  return { name: registeredName };  // was: { name }
}
```

### `ActionSpec.name` becomes optional

```typescript
// packages/dagraph/src/define-action.ts
interface ActionSpec<Ctx, P extends BaseParams, R extends Outputs, C = string> {
  name?: (params: P) => string;  // defaults to (p) => p.kind
  config: C;
  concurrencyGroup?: string;
  action: (ctx: Ctx, config: C) => ActionFunc<P, R>;
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
interface ActionDef<Ctx, P extends BaseParams, R extends Outputs> {
  addNode: (target: GraphTarget, ctx: Ctx, params: P) => NodeRef<R>;  // was: graph: Graph
  createAction: (ctx: Ctx) => ActionFunc<P, R>;
}
```

### `analyze()` gains `byScope`

```typescript
// packages/dagraph/src/types.ts — extend AnalysisResult
interface AnalysisResult {
  nodes: Node[];
  total: number;
  byKind: Map<string, number>;
  byScope: Map<string, number>;  // NEW: scope prefix → count (unscoped nodes under "" key)
}
```

Scope is derived from node names: `name.includes(":") ? name.slice(0, name.indexOf(":")) : ""`.

### Naming format change

Node names change from `download:videoId` to `videoId:download` (scope:kind). This is the standard namespacing convention. Existing caches will invalidate (one-time, not a problem).

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

Current code parses `kind:videoId` names. After this change, names are `videoId:kind`. All name-parsing logic needs to flip:

- **Video group extraction**: `name.slice(colon + 1)` → `name.slice(0, colon)` (extract scope prefix, not suffix)
- **Kind-based `startsWith` checks**: `n.name.startsWith("download:")` → match on kind portion after the colon, e.g. `n.kind === NodeKind.Download`
- **Dep filtering**: `d.endsWith(vid)` → `d.startsWith(vid + ":")` (deps within the same video scope share the prefix, not suffix)
- **RSS entry filtering**: `n.name.startsWith("rss_entry:")` → `n.kind === NodeKind.RssEntry`

Using `node.kind` instead of string-parsing `node.name` is more robust and decouples mermaid rendering from the naming convention.

### `define-action.ts` — cleanup

Delete `toVideoActionName`.

### Tests — use `scope()` and return registered names

`addItemNodes` in `dag.test.ts` uses `graph.scope(id)` and chains the returned names as deps. Node name references update from `fetch:aaa` to `aaa:fetch`.

## Files to modify

| File | Change |
|---|---|
| `packages/dagraph/src/types.ts` | Add `GraphTarget` interface, add `byScope` to `AnalysisResult` |
| `packages/dagraph/src/graph.ts` | `Graph` implements `GraphTarget`, `add()` returns `string`, add `scope()`, update `addNode()` to take `GraphTarget` and use return value |
| `packages/dagraph/src/define-action.ts` | `name` optional in `ActionSpec`, `GraphTarget` in `ActionDef.addNode` |
| `packages/dagraph/src/helpers.ts` | Add scope-extraction helper for `byScope` computation |
| `packages/dagraph/src/index.ts` | Export `GraphTarget` type |
| `packages/dagraph/src/dag.test.ts` | Use `scope()`, update name references |
| `src/pipeline/actions/define-action.ts` | Delete `toVideoActionName` |
| `src/pipeline/actions/download.ts` | Remove `name` field |
| `src/pipeline/actions/transcribe.ts` | Remove `name` field |
| `src/pipeline/actions/thumbnail.ts` | Remove `name` field |
| `src/pipeline/actions/chapters.ts` | Remove `name` field |
| `src/pipeline/actions/embed-chapters.ts` | Remove `name` field |
| `src/pipeline/actions/summary.ts` | Remove `name` field |
| `src/pipeline/actions/rss-entry.ts` | Remove `name` field |
| `src/pipeline/actions/artwork.ts` | Remove `name` field (both `channelAvatar` and `artwork`) |
| `src/pipeline/graph-builder.ts` | Use `graph.scope(video.id)` |
| `src/cli/commands/graph/mermaid.ts` | Use `node.kind` instead of string-parsing `node.name`; flip scope extraction to `name.slice(0, colon)` |

## Future (not in this PR)

- `execute({ scopes: ["abc123"] })` — selective execution of specific scopes
- Nested scopes via `GraphTarget.scope()` (trivial extension)
- Per-scope failure summaries in CLI output

## Verification

1. `bunx tsgo` — type-checks clean
2. `bun test` — all tests pass
3. `bun run src/cli/cli.ts graph <channel> -n 2` — mermaid output groups videos correctly
4. `bun run src/cli/cli.ts sync <channel> -n 1` — end-to-end execution works
