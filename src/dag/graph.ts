import type {
  ActionFunc,
  AnalysisResult,
  AnalyzedNode,
  BaseParams,
  Cache,
  ExecResult,
  ExecuteOptions,
  InputsFor,
  Node,
  NodeRef,
  NodeRunner,
} from "./types";

import * as execState from "./exec-state";
import { computeHash, toCounts, validateNoCycles } from "./helpers";

type NodeDef = Omit<Node, "hash">;

function depsFromParams(params: BaseParams): string[] {
  if (!params.deps) return [];
  return Object.values(params.deps)
    .filter((v) => v != null)
    .map((v) => v.name);
}

function parseInputsFor<P>(params: BaseParams, rawInputs: Record<string, string>): InputsFor<P> {
  return Object.fromEntries(
    Object.entries(params.deps || [])
      .map(([role, ref]) => [role, ref && rawInputs[ref.name]])
      .filter((entry): entry is [string, string] => Boolean(entry[1]))
      .map(([role, ref]) => [role, JSON.parse(ref)]),
  ) as InputsFor<P>;
}

export function addNode<P extends BaseParams, R>(
  graph: Graph,
  name: string,
  config: string,
  params: P,
  action: ActionFunc<P, R>,
): NodeRef<R> {
  graph.add({
    name,
    kind: params.kind,
    deps: depsFromParams(params),
    config,
    params,
    action: async (rawInputs) =>
      JSON.stringify(await action(params, parseInputsFor<P>(params, rawInputs))),
  });
  return { name };
}

export const localRunner: NodeRunner = (node, rawInputs) => node.action(rawInputs);

export class Graph {
  private nodes = new Map<string, Node>();
  constructor(private cache: Cache) {}

  add(def: NodeDef): void {
    if (this.nodes.has(def.name)) throw new Error(`duplicate node name: "${def.name}"`);
    const depHashes = new Map(
      def.deps.map((d) => {
        const dep = this.nodes.get(d);
        if (!dep) throw new Error(`node "${def.name}" depends on unknown node "${d}"`);
        return [d, dep.hash];
      }),
    );
    this.nodes.set(def.name, { ...def, hash: computeHash(def, depHashes) });
  }

  getNodes(): ReadonlyMap<string, Node> {
    return this.nodes;
  }

  analyze(): AnalysisResult {
    validateNoCycles(this.nodes);
    const analyzed = Array.from(this.nodes.values(), (node): AnalyzedNode => {
      const [cachedResult, hit] = this.cache.get(node.hash);
      return { ...node, dirty: !hit, ...(hit ? { cachedResult } : {}) };
    });
    const totalCounts = toCounts(analyzed);
    const byKindCounts = new Map(
      Array.from(
        Map.groupBy(analyzed, (n) => n.kind),
        ([kind, nodes]) => [kind, toCounts(nodes)],
      ),
    );
    return { nodes: analyzed, totalCounts, byKind: byKindCounts };
  }

  async execute(runner: NodeRunner = localRunner, opts?: ExecuteOptions): Promise<ExecResult[]> {
    const { maxParallelism, onAction } = opts ?? {};
    const state = execState.createExecState(this.nodes.values());
    const dispatch = (action: execState.ExecAction) => {
      execState.send(state, action);
      onAction?.(action);
    };

    const processNode = async (node: Node): Promise<void> => {
      const failedTransitiveDep = execState.failedTransitiveDep(node, state);
      if (failedTransitiveDep) {
        dispatch({
          type: "dep-failure",
          node,
          error: new Error(`dependency ${failedTransitiveDep} failed`),
        });
        return;
      }

      const [cachedResult, hit] = this.cache.get(node.hash);
      if (hit) {
        dispatch({ type: "cache-hit", node, cachedResult });
        return;
      }

      dispatch({ type: "start", node });
      const startTime = Date.now();
      try {
        const result = await runner(node, execState.inputsFor(node, state));
        this.cache.put(node.hash, result);
        dispatch({ type: "success", node, result, elapsed: Date.now() - startTime });
      } catch (e) {
        dispatch({ type: "failure", node, error: e, elapsed: Date.now() - startTime });
      }
    };

    let resumeLoop: () => void = () => {};
    while (execState.hasWork(state)) {
      while (execState.hasCapacity(state, maxParallelism)) {
        const node = execState.takeNext(state);
        processNode(node).finally(() => {
          dispatch({ type: "complete", node });
          resumeLoop();
        });
      }
      await new Promise<void>((r) => {
        resumeLoop = r;
      });
    }

    await this.cache.flush?.();
    return [...state.execResults.values()];
  }
}
