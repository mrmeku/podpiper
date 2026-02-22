# Bazel-like Merkle Tree with Output Hashing

## Context

The DAG engine (`packages/dag/src/`) computes node hashes from `sha256(name + config + dep_hashes)` at graph construction time. These hashes capture input identity but ignore actual outputs. If a node re-executes (because its config changed) but produces identical output files, all downstream nodes still re-execute because their hashes changed.

Bazel solves this with **output hashing and early cutoff**: after execution, hash the action's output files. Use these output hashes when computing downstream action keys. If a node's outputs didn't change, its dependents' action keys are stable and they stay cached.

Enforce a **pure Bazel model**: every action writes output to files and returns file paths. Return type constrained to `string | string[] | Record<string, string | string[]>`.

## Design

### Concepts

- **Output hash**: Hash of an action's output file contents. Computed after execution.
- **Action key**: `sha256(name + config + dep_content_hashes)`. Computed at execution time. Used for cache lookup. Enables early cutoff.

Nodes no longer store a pre-computed hash. Hashes are computed at execution time using dep content hashes.

### Execution flow

```
for each ready node (topological order):
  1. collect dep content hashes from state.contentHashes
  2. actionKey = sha256(name + config + sorted dep content hashes)
  3. cache.get(actionKey) → hit?
     yes → extract {outputs, contentHash}, store both, skip
     no  → execute action
           → compute contentHash = hashOutputFiles(outputs)
           → cache.put(actionKey, {outputs, contentHash})
           → store outputs + contentHash in state
```

Early cutoff is emergent: if node A re-executes with same content hash, node B's action key = `sha256(B.name + B.config + A.contentHash)` is unchanged, so B gets a cache hit.

### `analyze()` simplification

Drop dirty/cached prediction. `analyze()` becomes:

1. Validate graph (no cycles)
2. Return node counts by kind

No hash computation, no cache lookup. Dirty/cached info comes from `execute()` progress events. This eliminates the dual-key cache complexity — cache is single-keyed by action key.

The CLI rendering layer (`src/cli/commands/sync/render.ts`) needs minor updates:

- `renderAnalysisSummary`: show total nodes by kind (no dirty/cached)
- `createProgressRenderer`: create bars per kind using total counts, update dynamically from events

### Output hashing

`hashOutputFiles(jsonOutputs: string)` is built into the DAG engine (`helpers.ts`). Parses the JSON as `Outputs`, extracts file paths via `collectPaths`, computes `sha256(file contents)` using `node:fs`.

DAG-level tests write real files to tmpdir (same pattern as existing `LocalCache` tests).

## Changes by file

### `packages/dag/src/types.ts`

```typescript
// New: constrained output type
export type Outputs = string | string[] | Record<string, string | string[]>;

// ActionFunc: add R extends Outputs
export type ActionFunc<P extends BaseParams, R extends Outputs> = ...

// NodeRef: add constraint
export interface NodeRef<T extends Outputs = Outputs> { ... }

// Node: drop the `hash` field. Hashes computed at execution time.
export interface Node {
  name: string;
  kind: string;
  deps: string[];
  config: string;
  params: BaseParams;
  action: (rawInputs: Record<string, string>) => Promise<string>;
}

// Cache entry: what gets stored per action key.
// Example for a download action:
//   outputs:     '{"audio":"/out/v1/audio.mp3","info":"/out/v1/audio.info.json","thumb":"/out/v1/audio.jpg"}'
//   contentHash: 'a3f2b1...' (SHA256 of the bytes in those 3 files)
//
// `outputs` is needed on cache hit to provide file paths to downstream nodes.
// `contentHash` is used to compute action keys of dependent nodes (early cutoff).
export interface CacheEntry {
  outputs: string;       // JSON-serialized Outputs — the file paths the action produced
  contentHash: string;   // SHA256 of actual file contents at those paths
}

// Cache: simple key-value store with CacheEntry values
export interface Cache {
  get(key: string): [CacheEntry, boolean];
  put(key: string, entry: CacheEntry): void;
  flush?: () => void | Promise<void>;
}

// ExecResult: actionKey replaces hash, add contentHash
export type ExecResult = { name: string; actionKey: string } & (
  | { status: "done"; outputs: string; contentHash: string }
  | { status: "cached"; outputs: string; contentHash: string }
  | { status: "fail"; error: Error }
  | { status: "dep-failed"; error: Error }
);

// AnalysisResult: just structure, no dirty/cached prediction
export interface AnalysisResult {
  nodes: Node[];
  totalCounts: { total: number };
  byKind: Map<string, { total: number }>;
}
```

### `packages/dag/src/helpers.ts`

```typescript
// Existing computeHash: reused for action key computation (same function, fed dep content hashes)

// New: extract file paths from Outputs
export function collectPaths(outputs: Outputs): string[] {
  if (typeof outputs === "string") return [outputs];
  if (Array.isArray(outputs)) return outputs;
  return Object.values(outputs).flatMap((v) => (Array.isArray(v) ? v : [v]));
}

// New: hash output file contents
export async function hashOutputFiles(jsonResult: string): Promise<string> {
  const outputs = JSON.parse(jsonResult) as Outputs;
  const paths = collectPaths(outputs).sort();
  const h = createHash("sha256");
  h.update(String(paths.length));
  for (const p of paths) {
    const content = await readFile(p); // from node:fs/promises
    h.update(String(content.length));
    h.update(content);
  }
  return h.digest("hex");
}

// Remove: toCounts (no longer needed)
```

### `packages/dag/src/exec-state.ts`

```typescript
export interface ExecState {
  // ... existing fields
  contentHashes: Map<string, string>; // NEW: node name → content hash
}

// ExecAction: add actionKey, contentHash to relevant variants
export type ExecAction =
  | { type: "start"; node: Node }
  | { type: "complete"; node: Node }
  | { type: "cache-hit"; node: Node; actionKey: string; outputs: string; contentHash: string }
  | {
      type: "success";
      node: Node;
      actionKey: string;
      outputs: string;
      contentHash: string;
      elapsed: number;
    }
  | { type: "failure"; node: Node; error: unknown; elapsed: number }
  | { type: "dep-failure"; node: Node; error: unknown };

// send(): store contentHash on cache-hit and success
```

### `packages/dag/src/graph.ts`

`add()`: drop hash computation. Validate deps exist, store node.

`analyze()`: validate no cycles, return counts by kind. No hash computation.

`execute()`:

```typescript
async execute(runner, opts): Promise<ExecResult[]> {
  // ...
  const processNode = async (node) => {
    // 1. Check failed transitive dep (same as before)
    // 2. Compute action key from dep content hashes
    const depContentHashes = new Map(
      node.deps.map(d => [d, state.contentHashes.get(d)!])
    );
    const actionKey = computeHash(node, depContentHashes);
    // 3. Cache lookup by action key
    const [cached, hit] = this.cache.get(actionKey);
    if (hit) {
      state.contentHashes.set(node.name, cached.contentHash);
      dispatch({ type: "cache-hit", node, actionKey, ... });
      return;
    }
    // 4. Execute
    dispatch({ type: "start", node });
    const outputs = await runner(node, inputsFor(node, state));
    const contentHash = await hashOutputFiles(outputs);
    this.cache.put(actionKey, { outputs, contentHash });
    state.contentHashes.set(node.name, contentHash);
    dispatch({ type: "success", node, actionKey, outputs, contentHash, ... });
  };
}
```

### `packages/dag/src/cache.ts`

All cache implementations (`MemCache`, `LocalCache`, `TieredCache`) updated to store/retrieve `CacheEntry` (with `outputs` + `contentHash`) instead of raw strings.

### `packages/dag/src/define-action.ts`

Add `R extends Outputs` constraint to `ActionSpec` and `ActionDef`.

## Pipeline migration (separate step)

Actions that already return file paths need no changes:

| Action         | Current return                 | Change needed                           |
| -------------- | ------------------------------ | --------------------------------------- |
| download       | `{audio, info, thumb}` (paths) | None (`Record<string, string>`)         |
| transcribe     | `{srt, json}` (paths)          | None (`Record<string, string>`)         |
| thumbnail      | `string` (path)                | None (bare `string` is valid `Outputs`) |
| channel-avatar | `string` (path)                | None (bare `string` is valid `Outputs`) |

Actions that return data need to write files:

| Action    | Current return       | Change needed                                                     |
| --------- | -------------------- | ----------------------------------------------------------------- |
| chapters  | `Chapter[]`          | Write to JSON file, return `{chapters: path}` or single path      |
| summary   | `string` (text)      | Write to text file, return path                                   |
| rss-entry | `{episode, uploads}` | Write both to JSON files, return `{episode: path, uploads: path}` |
| artwork   | `{uploads}`          | Write uploads to JSON file, return path                           |

Downstream actions read from files using `ports.fs.readJson()` instead of receiving data directly.

CLI rendering (`src/cli/commands/sync/render.ts`): update `renderAnalysisSummary` and `createProgressRenderer` for simplified `AnalysisResult`.

## Implementation order

1. **DAG engine changes** (types, helpers, cache, exec-state, graph) - all within `packages/dag/src/`
2. **Update `dag.test.ts`** - tests write real files to tmpdir, verify early cutoff
3. **Add `R extends Outputs` constraint** - types, define-action
4. **Pipeline actions migration** - update return types, write data to files
5. **Pipeline consumers** - read from files instead of receiving data
6. **CLI rendering update** - adapt to simplified `AnalysisResult`
7. **Cache migration script** - one-time utility to convert old `cache.json` to new `CacheEntry` format

Steps 1-2 can be done without breaking the pipeline (don't add the type constraint yet). Steps 3-6 are a coordinated change.

## Verification

1. Run `bun test packages/dag/src/dag.test.ts` after DAG changes
2. Key test: **early cutoff** - node A re-executes (config change) but writes same file content → node B (depends on A) stays cached. Verify `exec: 1, skip: 1`.
3. Key test: **no cutoff when output changes** - A re-executes and writes different content → B re-executes too. Verify `exec: 2, skip: 0`.
4. Key test: **early cutoff chain** - A → B → C, A re-executes with same output → only A runs.
5. After pipeline migration: `bun run src/cli.ts sync <channel> -n 1` end-to-end
