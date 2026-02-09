import type { ExecAction } from "./exec-state";

export interface BaseParams {
  kind: string;
  deps?: Record<string, NodeRef | undefined>;
}

export type InputsFor<P> = P extends { deps: infer D }
  ? {
      [K in keyof D]: D[K] extends NodeRef<infer T> | undefined
        ? undefined extends D[K]
          ? T | undefined
          : T
        : unknown;
    }
  : {};

export type ActionFunc<P extends BaseParams, R> = (params: P, inputs: InputsFor<P>) => Promise<R>;

export interface Node {
  name: string;
  kind: string;
  deps: string[];
  config: string;
  params: BaseParams;
  action: (rawInputs: Record<string, string>) => Promise<string>;
}

export type NodeRunner = (node: Node, inputs: Record<string, string>) => Promise<string>;

export type NodeStatus = "done" | "cached" | "fail" | "dep-failed";

export type ExecResult = { name: string; hash: string } & (
  | { status: "done"; result: string }
  | { status: "cached"; result: string }
  | { status: "fail"; error: Error }
  | { status: "dep-failed"; error: Error }
);

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
  onAction?: (action: ExecAction) => void;
}

export interface NodeCounts {
  total: number;
  cached: number;
  dirty: number;
}

export interface AnalyzedNode {
  name: string;
  kind: string;
  deps: string[];
  hash: string;
  dirty: boolean;
  cachedResult?: string;
}

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
