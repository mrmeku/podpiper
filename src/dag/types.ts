export type ActionFunc = (inputs: Record<string, string>) => Promise<string>;

export interface Node {
  name: string;
  kind: string;
  deps: string[];
  config: string;
  action: ActionFunc;
}

export interface ExecResult {
  name: string;
  hash: string;
  result: string | null;
  skipped: boolean;
  error: Error | null;
}

export interface Cache {
  get(hash: string): [string, boolean];
  put(hash: string, result: string): void;
}

export interface Flushable {
  flush(): void | Promise<void>;
}

export interface NodeCounts {
  total: number;
  cached: number;
  dirty: number;
}

export interface PlanningResult {
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
