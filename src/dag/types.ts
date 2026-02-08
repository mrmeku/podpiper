export interface BaseParams {
  kind: string;
  deps?: Record<string, string | undefined>;
}

export type InputsFor<P> = P extends { deps: infer D }
  ? { [K in keyof D]: undefined extends D[K] ? string | undefined : string }
  : {};

export type ActionFunc<P extends BaseParams = BaseParams> =
  (params: P, inputs: InputsFor<P>) => Promise<string>;

export interface Node {
  name: string;
  kind: string;
  deps: string[];
  config: string;
  params: BaseParams;
  action: ActionFunc;
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

export function stringRef(name: string): NodeRef<string> {
  return { name, parse: (raw) => raw };
}

export function jsonRef<T>(name: string): NodeRef<T> {
  return { name, parse: (raw) => JSON.parse(raw) as T };
}
