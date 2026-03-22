import type { ExecAction } from "./exec-state";

/** Minimum contract for parameters passed to `addNode`. `kind` groups nodes for display/counting. */
export interface BaseParams {
  kind: string;
  deps?: Record<string, NodeRef | undefined>;
}

/** Constrained output type: actions must return file paths. */
export type Outputs = string | string[] | Record<string, string | string[]>;

/** Maps a params object's `deps` record to the deserialized output types of each dependency. */
export type InputsFor<P> = P extends { deps: infer D }
  ? {
      [K in keyof D]: D[K] extends NodeRef<infer T> | undefined
        ? undefined extends D[K]
          ? T | undefined
          : T
        : unknown;
    }
  : Record<string, never>;

/** User-supplied function that implements a DAG node's work. Receives typed params, dep outputs, and CAS output dir. */
export type ActionFunc<P extends BaseParams, R extends Outputs> = (
  params: P,
  inputs: InputsFor<P>,
  outputDir: string,
) => Promise<R>;

/** Serializable identity of a DAG node — no closures, safe for cross-process communication. */
export interface Node {
  name: string;
  kind: string;
  /** Names of nodes this node depends on (must complete first). */
  deps: string[];
  /** Serialized configuration — included in the action key so config changes invalidate cache. */
  config: string;
  /** Optional concurrency group. Nodes sharing a group are subject to a per-group parallelism limit. */
  concurrencyGroup?: string;
}

/** A Node with an executable action — the unit of work the executor actually runs. */
export interface RunnableNode extends Node {
  params: BaseParams;
  /** Raw executor-level action. Receives dep outputs as `Record<name, Outputs>` and CAS output dir, returns Outputs. */
  action: (rawInputs: Record<string, Outputs>, outputDir: string) => Promise<Outputs>;
}

/** Pluggable execution strategy — the executor calls this instead of `node.action` directly. */
export type NodeRunner = (node: RunnableNode, inputs: Record<string, Outputs>, outputDir: string) => Promise<Outputs>;

/** What gets stored per action key in the cache. */
export interface CacheEntry {
  /** The file paths the action produced. */
  outputs: Outputs;
  /** SHA256 of actual file contents at those paths. */
  contentHash: string;
}

/** Discriminated union of per-node outcomes after DAG execution. */
export type ExecResult = { name: string; actionKey: string } & (
  | { status: "done"; outputs: Outputs; contentHash: string }
  | { status: "cached"; outputs: Outputs; contentHash: string }
  | { status: "fail"; error: Error }
  | { status: "dep-failed"; error: Error }
);

/** Minimal filesystem contract the DAG executor needs. */
export interface DagFs {
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  hashFile(path: string): Promise<string>;
  ensureDir(path: string): Promise<void>;
}

/** Content-addressed cache used by the executor to skip unchanged nodes. */
export interface Cache {
  get(key: string): Promise<CacheEntry | undefined>;
  put(key: string, entry: CacheEntry): Promise<void>;
}

export interface ExecuteOptions {
  maxParallelism?: number;
  /** Per-group concurrency limits. Keys are group names, values are max inflight for that group. */
  concurrencyLimits?: Record<string, number>;
  /** Observer callback — receives every ExecAction dispatched during execution. */
  onAction?: (action: ExecAction) => void;
  /** Skip cache lookups — every node re-executes from scratch. */
  force?: boolean;
}

/** Output of `graph.analyze()` — structural info, no cache prediction. */
export interface AnalysisResult {
  nodes: Node[];
  total: number;
  byKind: Map<string, number>;
}

/** Type-safe handle to a DAG node. T is the output type of the node's action. */
export interface NodeRef<T extends Outputs = Outputs> {
  name: string;
  readonly _T?: T;
}

/** Result of processing a single node — returned by `processNode`. */
type ProcessNodeResultBase = { name: string; actionKey: string };
export type ProcessNodeResult = ProcessNodeResultBase &
  (
    | { status: "done"; outputs: Outputs; contentHash: string; elapsed: number }
    | { status: "cached"; outputs: Outputs; contentHash: string }
    | { status: "fail"; error: string; elapsed: number }
    | { status: "dep-failed"; error: string }
  );
