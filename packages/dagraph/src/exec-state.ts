import type { ExecResult, Node, Outputs } from "./types";

export interface ExecState {
  dependents: Map<string, Node[]>;
  results: Map<string, Outputs>;
  contentHashes: Map<string, string>;
  execResults: Map<string, ExecResult>;
  failed: Set<string>;
  ready: Node[];
  enqueued: Set<string>;
  inflight: number;
  groupInflight: Map<string, number>;
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
    results: new Map(),
    contentHashes: new Map(),
    execResults: new Map(),
    failed: new Set(),
    ready: leafs,
    enqueued: new Set(leafs.map((n) => n.name)),
    inflight: 0,
    groupInflight: new Map(),
  };
}

// --- actions ---

export function tryTakeNext(
  state: ExecState,
  maxParallelism?: number,
  concurrencyLimits?: Record<string, number>,
): Node | null {
  if (state.ready.length === 0) return null;
  if (maxParallelism != null && state.inflight >= maxParallelism) return null;
  const idx = concurrencyLimits
    ? state.ready.findIndex((node) => {
        const group = node.concurrencyGroup;
        if (!group) return true;
        const limit = concurrencyLimits[group];
        if (limit == null) return true;
        return (state.groupInflight.get(group) ?? 0) < limit;
      })
    : 0;
  if (idx === -1) return null;
  const node = state.ready.splice(idx, 1)[0]!;
  state.inflight++;
  const group = node.concurrencyGroup;
  if (group) {
    state.groupInflight.set(group, (state.groupInflight.get(group) ?? 0) + 1);
  }
  return node;
}

export type ExecAction =
  | { type: "start"; node: Node }
  | { type: "complete"; node: Node }
  | { type: "cache-hit"; node: Node; actionKey: string; outputs: Outputs; contentHash: string }
  | {
      type: "success";
      node: Node;
      actionKey: string;
      outputs: Outputs;
      contentHash: string;
      elapsed: number;
    }
  | { type: "failure"; node: Node; error: unknown; elapsed: number }
  | { type: "dep-failure"; node: Node; error: unknown };

export function send(state: ExecState, action: ExecAction): void {
  switch (action.type) {
    case "start":
      return;
    case "complete": {
      state.inflight--;
      const group = action.node.concurrencyGroup;
      if (group) {
        const count = state.groupInflight.get(group)!;
        if (count <= 1) state.groupInflight.delete(group);
        else state.groupInflight.set(group, count - 1);
      }
      const children = (state.dependents.get(action.node.name) ?? []).filter(
        (child) =>
          !state.enqueued.has(child.name) && child.deps.every((d) => state.execResults.has(d)),
      );
      state.ready.unshift(...children);
      for (const c of children) state.enqueued.add(c.name);
      return;
    }
    case "cache-hit": {
      const { node, actionKey, outputs, contentHash } = action;
      state.results.set(node.name, outputs);
      state.contentHashes.set(node.name, contentHash);
      state.execResults.set(node.name, {
        name: node.name,
        actionKey,
        status: "cached",
        outputs,
        contentHash,
      });
      return;
    }
    case "success": {
      const { node, actionKey, outputs, contentHash } = action;
      state.results.set(node.name, outputs);
      state.contentHashes.set(node.name, contentHash);
      state.execResults.set(node.name, {
        name: node.name,
        actionKey,
        status: "done",
        outputs,
        contentHash,
      });
      return;
    }
    case "failure": {
      const { node } = action;
      const error = action.error instanceof Error ? action.error : new Error(String(action.error));
      state.failed.add(node.name);
      state.execResults.set(node.name, {
        name: node.name,
        actionKey: "",
        status: "fail",
        error,
      });
      return;
    }
    case "dep-failure": {
      const { node } = action;
      const error = action.error instanceof Error ? action.error : new Error(String(action.error));
      state.failed.add(node.name);
      state.execResults.set(node.name, {
        name: node.name,
        actionKey: "",
        status: "dep-failed",
        error,
      });
      return;
    }
  }
}

// --- selectors ---

export function hasWork(state: ExecState): boolean {
  return state.ready.length > 0 || state.inflight > 0;
}

export function inputsFor(node: Node, state: ExecState): Record<string, Outputs> {
  return Object.fromEntries(node.deps.map((d) => [d, state.results.get(d)!]));
}

export function failedTransitiveDep(node: Node, state: ExecState): string | undefined {
  return node.deps.find((d) => state.failed.has(d));
}
