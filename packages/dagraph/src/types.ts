import type { ExecAction } from "./exec-state";

/** Constrained output type: actions must return file paths. */
export type Outputs = string | string[] | Record<string, string | string[]>;

/** User-supplied function that implements a DAG node's work. */
export type ActionFunc<
  Inputs extends Record<string, Outputs> = Record<string, never>,
  R extends Outputs = Outputs,
> = (ctx: { id: string | undefined; inputs: Inputs; outputDir: string }) => Promise<R>;

/** Maps an action's inputs record to the corresponding NodeRef deps record, preserving optionality. */
export type DepsFor<Inputs> = {
  [K in keyof Inputs]-?: undefined extends Inputs[K]
    ? NodeRef<Exclude<Inputs[K], undefined> & Outputs> | undefined
    : NodeRef<Inputs[K] & Outputs>;
};

/** A single unit of work in the DAG. All values are Outputs at the executor level. */
export interface Node {
  name: string;
  kind: string;
  /** Names of nodes this node depends on (must complete first). */
  deps: string[];
  /** Serialized configuration — included in the action key so config changes invalidate cache. */
  config: string;
  /** Raw executor-level action. Receives dep outputs as `Record<name, Outputs>` and CAS output dir, returns Outputs. */
  action: (rawInputs: Record<string, Outputs>, outputDir: string) => Promise<Outputs>;
}

/** Pluggable execution strategy — the executor calls this instead of `node.action` directly. */
export type NodeRunner = (node: Node, inputs: Record<string, Outputs>, outputDir: string) => Promise<Outputs>;

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
  /** Observer callback — receives every ExecAction dispatched during execution. */
  onAction?: (action: ExecAction) => void;
}

/** Kind-level dependency edge — collapses concrete nodes into kind-level topology. */
export interface KindEdge {
  kind: string;
  depKinds: string[];
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
