import type { ExecAction } from "./exec-state";

/** Minimum contract for parameters passed to `addNode`. `kind` groups nodes for display/counting. */
export interface BaseParams {
  kind: string;
  deps?: Record<string, NodeRef | undefined>;
}

/** Maps a params object's `deps` record to the deserialized output types of each dependency. */
export type InputsFor<P> = P extends { deps: infer D }
  ? {
      [K in keyof D]: D[K] extends NodeRef<infer T> | undefined
        ? undefined extends D[K]
          ? T | undefined
          : T
        : unknown;
    }
  : {};

/** User-supplied function that implements a DAG node's work. Receives typed params and dep outputs. */
export type ActionFunc<P extends BaseParams, R> = (params: P, inputs: InputsFor<P>) => Promise<R>;

/** A single unit of work in the DAG. All values are serialized strings at the executor level. */
export interface Node {
  name: string;
  kind: string;
  /** Names of nodes this node depends on (must complete first). */
  deps: string[];
  /** Serialized configuration — included in the content hash so config changes invalidate cache. */
  config: string;
  /** Content hash — SHA256 of name, config, and sorted dep hashes. Computed at insertion time. */
  hash: string;
  params: BaseParams;
  /** Raw executor-level action. Receives dep results as `Record<name, JSON string>`, returns JSON string. */
  action: (rawInputs: Record<string, string>) => Promise<string>;
}

/** Pluggable execution strategy — the executor calls this instead of `node.action` directly. */
export type NodeRunner = (node: Node, inputs: Record<string, string>) => Promise<string>;

/** Discriminated union of per-node outcomes after DAG execution. */
export type ExecResult = { name: string; hash: string } & (
  | { status: "done"; result: string }
  | { status: "cached"; result: string }
  | { status: "fail"; error: Error }
  | { status: "dep-failed"; error: Error }
);

/** Content-addressed cache used by the executor to skip unchanged nodes. */
export interface Cache {
  get(hash: string): [string, boolean];
  put(hash: string, result: string): void;
  flush?: () => void | Promise<void>;
}

export interface Flushable {
  flush: () => void | Promise<void>;
}

export interface ExecuteOptions {
  maxParallelism?: number;
  /** Observer callback — receives every ExecAction dispatched during execution. */
  onAction?: (action: ExecAction) => void;
}

/** Aggregate counts for a set of analyzed nodes. */
export interface NodeCounts {
  total: number;
  cached: number;
  dirty: number;
}

/** Pre-execution snapshot of a single node: whether it needs to run, and any cached result. */
export interface AnalyzedNode extends Node {
  dirty: boolean;
  cachedResult?: string;
}

/** Output of `graph.analyze()` — a dry-run view of what would execute. */
export interface AnalysisResult {
  nodes: AnalyzedNode[];
  totalCounts: NodeCounts;
  byKind: Map<string, NodeCounts>;
}

/** Type-safe handle to a DAG node. T is the deserialized output type of the node's action. */
export interface NodeRef<T = unknown> {
  name: string;
  readonly _T?: T;
}

export function parseRef<T>(_ref: NodeRef<T>, raw: string): T {
  return JSON.parse(raw) as T;
}
