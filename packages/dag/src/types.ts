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

/** User-supplied function that implements a DAG node's work. Receives typed params and dep outputs. */
export type ActionFunc<P extends BaseParams, R extends Outputs> = (
  params: P,
  inputs: InputsFor<P>,
) => Promise<R>;

/** A single unit of work in the DAG. All values are Outputs at the executor level. */
export interface Node {
  name: string;
  kind: string;
  /** Names of nodes this node depends on (must complete first). */
  deps: string[];
  /** Serialized configuration — included in the action key so config changes invalidate cache. */
  config: string;
  params: BaseParams;
  /** Raw executor-level action. Receives dep outputs as `Record<name, Outputs>`, returns Outputs. */
  action: (rawInputs: Record<string, Outputs>) => Promise<Outputs>;
}

/** Pluggable execution strategy — the executor calls this instead of `node.action` directly. */
export type NodeRunner = (node: Node, inputs: Record<string, Outputs>) => Promise<Outputs>;

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
