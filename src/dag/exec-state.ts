import type { ExecResult, Node } from "./types";

export interface ExecState {
  dependents: Map<string, Node[]>;
  hashes: Map<string, string>;
  results: Map<string, string>;
  execResults: Map<string, ExecResult>;
  failed: Set<string>;
  ready: Node[];
  enqueued: Set<string>;
  inflight: number;
}

function buildDependents(nodes: Iterable<Node>): Map<string, Node[]> {
  const acc = new Map<string, Node[]>();
  for (const node of nodes) {
    for (const dep of node.deps) {
      if (!acc.has(dep)) acc.set(dep, []);
      acc.get(dep)!.push(node);
    }
  }
  return acc;
}

export function createExecState(nodes: Iterable<Node>): ExecState {
  const allNodes = Array.from(nodes);
  const leafs = allNodes.filter((n) => n.deps.length === 0);
  return {
    dependents: buildDependents(allNodes),
    hashes: new Map(),
    results: new Map(),
    execResults: new Map(),
    failed: new Set(),
    ready: leafs,
    enqueued: new Set(leafs.map((n) => n.name)),
    inflight: 0,
  };
}

// --- actions ---

export function takeNext(state: ExecState): Node {
  const node = state.ready.shift()!;
  state.inflight++;
  return node;
}

export type ExecAction =
  | { type: "complete"; node: Node }
  | { type: "cache-hit"; node: Node; hash: string; cachedResult: string }
  | { type: "success"; node: Node; hash: string; result: string }
  | { type: "failure"; node: Node; hash: string; error: unknown };

export function send(state: ExecState, action: ExecAction): void {
  switch (action.type) {
    case "complete": {
      state.inflight--;
      const children = (state.dependents.get(action.node.name) ?? []).filter(
        (child) =>
          !state.enqueued.has(child.name) && child.deps.every((d) => state.execResults.has(d)),
      );
      state.ready.unshift(...children);
      for (const c of children) state.enqueued.add(c.name);
      return;
    }
    case "cache-hit": {
      const { node, hash, cachedResult } = action;
      state.hashes.set(node.name, hash);
      state.results.set(node.name, cachedResult);
      state.execResults.set(node.name, {
        name: node.name,
        hash,
        status: "cached",
        result: cachedResult,
      });
      return;
    }
    case "success": {
      const { node, hash, result } = action;
      state.hashes.set(node.name, hash);
      state.results.set(node.name, result);
      state.execResults.set(node.name, { name: node.name, hash, status: "done", result });
      return;
    }
    case "failure": {
      const { node, hash } = action;
      const error = action.error instanceof Error ? action.error : new Error(String(action.error));
      state.failed.add(node.name);
      state.execResults.set(node.name, { name: node.name, hash, status: "fail", error });
      return;
    }
  }
}

// --- selectors ---

export function hasWork(state: ExecState): boolean {
  return state.ready.length > 0 || state.inflight > 0;
}

export function canDispatch(state: ExecState, maxParallelism?: number): boolean {
  return state.ready.length > 0 && (maxParallelism == null || state.inflight < maxParallelism);
}

export function depHashesFor(node: Node, state: ExecState): Map<string, string> {
  return new Map(node.deps.map((d) => [d, state.hashes.get(d) ?? ""]));
}

export function inputsFor(node: Node, state: ExecState): Record<string, string> {
  return Object.fromEntries(node.deps.map((d) => [d, state.results.get(d) ?? ""]));
}

export function firstFailedDep(node: Node, state: ExecState): string | undefined {
  return node.deps.find((d) => state.failed.has(d));
}
