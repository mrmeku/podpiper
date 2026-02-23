import type {
  ActionFunc,
  AnalysisResult,
  BaseParams,
  InputsFor,
  KindEdge,
  Node,
  NodeRef,
  NodeRunner,
  Outputs,
} from "./types";

import { validateNoCycles } from "./helpers";

function depsFromParams(params: BaseParams): string[] {
  if (!params.deps) return [];
  return Object.values(params.deps)
    .filter((v) => v != null)
    .map((v) => v.name);
}

function resolveInputs<P>(params: BaseParams, rawInputs: Record<string, Outputs>): InputsFor<P> {
  return Object.fromEntries(
    Object.entries(params.deps || [])
      .map(([role, ref]) => [role, ref && rawInputs[ref.name]])
      .filter((entry): entry is [string, Outputs] => entry[1] != null),
  ) as InputsFor<P>;
}

export function addNode<P extends BaseParams, R extends Outputs>({
  action,
  config,
  graph,
  name,
  params,
}: {
  graph: Graph;
  name: string;
  config: string;
  params: P;
  action: ActionFunc<P, R>;
}): NodeRef<R> {
  graph.add({
    name,
    kind: params.kind,
    deps: depsFromParams(params),
    config,
    params,
    action: (rawInputs, outputDir) => action(params, resolveInputs<P>(params, rawInputs), outputDir),
  });
  return { name };
}

export const localRunner: NodeRunner = (node, rawInputs, outputDir) => node.action(rawInputs, outputDir);

export class Graph {
  private nodes = new Map<string, Node>();

  add(def: Node): void {
    if (this.nodes.has(def.name)) throw new Error(`duplicate node name: "${def.name}"`);
    for (const d of def.deps) {
      if (!this.nodes.has(d)) throw new Error(`node "${def.name}" depends on unknown node "${d}"`);
    }
    this.nodes.set(def.name, def);
  }

  getNodes(): ReadonlyMap<string, Node> {
    return this.nodes;
  }

  kindTopology(): KindEdge[] {
    const kindDeps = new Map<string, Set<string>>();
    const kindOrder: string[] = [];
    for (const node of this.nodes.values()) {
      if (!kindDeps.has(node.kind)) {
        kindDeps.set(node.kind, new Set());
        kindOrder.push(node.kind);
      }
      for (const depName of node.deps) {
        kindDeps.get(node.kind)!.add(this.nodes.get(depName)!.kind);
      }
    }
    return kindOrder.map((kind) => ({ kind, depKinds: [...kindDeps.get(kind)!] }));
  }

  analyze(): AnalysisResult {
    validateNoCycles(this.nodes);
    const nodes = Array.from(this.nodes.values());
    const byKind = new Map(
      Array.from(
        Map.groupBy(nodes, (n) => n.kind),
        ([kind, group]) => [kind, group.length],
      ),
    );
    return { nodes, total: nodes.length, byKind };
  }
}
