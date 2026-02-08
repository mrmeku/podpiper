export type DepName<T = unknown> = string & { readonly __resultType?: T };

export function dep<T>(ref: NodeRef<T>): DepName<T> {
  return ref.name as DepName<T>;
}

export interface BaseParams {
  kind: string;
  deps?: Record<string, DepName | undefined>;
}

export type InputsFor<P> = P extends { deps: infer D }
  ? {
      [K in keyof D]: D[K] extends DepName<infer T> | undefined
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

export type ProgressEvent = { node: string; kind: string } & (
  | { status: "start" }
  | { status: "done"; elapsed: number }
  | { status: "cached" }
  | { status: "fail"; error: string; elapsed: number }
  | { status: "dep-failed"; error: string }
);

export type ProgressCallback = (event: ProgressEvent) => void;

export interface ExecuteOptions {
  maxParallelism?: number;
  onProgress?: ProgressCallback;
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

export interface NodeRef<T> {
  name: string;
  parse: (raw: string) => T;
}

export function jsonRef<T>(name: string): NodeRef<T> {
  return { name, parse: (raw) => JSON.parse(raw) as T };
}
