import type {
  ActionFunc,
  AnalysisResult,
  BaseParams,
  InputsFor,
  Node,
  NodeRef,
  NodeRunner,
  Outputs,
  RunnableNode,
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
  concurrencyGroup,
  config,
  graph,
  name,
  params,
}: {
  graph: Graph;
  name: string;
  config: string;
  concurrencyGroup?: string;
  params: P;
  action: ActionFunc<P, R>;
}): NodeRef<R> {
  const registeredName = graph.add({
    name,
    kind: params.kind,
    deps: depsFromParams(params),
    config,
    ...(concurrencyGroup && { concurrencyGroup }),
    params,
    action: (rawInputs, outputDir) =>
      action(params, resolveInputs<P>(params, rawInputs), outputDir),
  });
  return { name: registeredName };
}

export const localRunner: NodeRunner = (node, rawInputs, outputDir) =>
  node.action(rawInputs, outputDir);

export class Graph {
  private nodes: Map<string, RunnableNode>;
  private prefix: string;

  constructor(prefix = "", nodes?: Map<string, RunnableNode>) {
    this.prefix = prefix;
    this.nodes = nodes ?? new Map();
  }

  add(def: RunnableNode): string {
    const name = this.prefix ? `${this.prefix}:${def.name}` : def.name;
    const prefixed = this.prefix ? { ...def, name } : def;
    if (this.nodes.has(name)) {
      const colon = name.indexOf(":");
      if (colon === -1) {
        throw new Error(
          `Duplicate node name "${name}". A node with this name already exists.\n` +
            `  Hint: If you're adding multiple instances of the same action, wrap each group\n` +
            `  in graph.scope(id) to namespace them — e.g. graph.scope("abc123").`,
        );
      }
      const scope = name.slice(0, colon);
      const kind = name.slice(colon + 1);
      const existingNode = this.nodes.get(name)!;
      const existingColon = existingNode.name.indexOf(":");
      if (existingColon !== -1 && existingNode.name.slice(0, existingColon) === scope) {
        throw new Error(
          `Duplicate node name "${name}". A node with this name already exists in scope "${scope}".\n` +
            `  Hint: If you need multiple "${kind}" nodes in the same scope, use distinct kind values.`,
        );
      }
      throw new Error(
        `Duplicate node name "${name}". A node with this name already exists.\n` +
          `  Hint: This may be a conflict between a scoped node (via graph.scope("${scope}"))\n` +
          `  and a manually-named node. Check for hardcoded names that match the scope:kind pattern.`,
      );
    }
    for (const d of prefixed.deps) {
      if (!this.nodes.has(d)) throw new Error(`node "${name}" depends on unknown node "${d}"`);
    }
    this.nodes.set(name, prefixed);
    return name;
  }

  scope(prefix: string): Graph {
    const fullPrefix = this.prefix ? `${this.prefix}:${prefix}` : prefix;
    return new Graph(fullPrefix, this.nodes);
  }

  getNodes(): ReadonlyMap<string, RunnableNode> {
    return this.nodes;
  }

  /** Return the graph as serializable nodes — no closures, safe for Temporal workflow sandbox. */
  describe(): Node[] {
    return Array.from(this.nodes.values()).map(
      ({ action: _action, params: _params, ...node }) => node,
    );
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
