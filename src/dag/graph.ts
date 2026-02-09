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

  add(node: Node): void {
    this.nodes.set(node.name, node);
  }

  getNodes(): ReadonlyMap<string, Node> {
    return this.nodes;
  }

  analyze(): AnalysisResult {
    validateNoCycles(this.nodes);
    const hashes = new Map<string, string>();

    const analyzed = Array.from(this.nodes.entries(), ([name, node]): AnalyzedNode => {
      const depHashes = new Map(node.deps.map((d) => [d, hashes.get(d) ?? ""]));
      const hash = computeHash(node, depHashes);
      hashes.set(name, hash);
      const [cachedResult, hit] = this.cache.get(hash);
      return {
        name,
        kind: node.kind,
        deps: node.deps,
        hash,
        dirty: !hit,
        ...(hit ? { cachedResult } : {}),
      };
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
    const { maxParallelism, onProgress: progressCallback } = opts ?? {};
    const state = execState.createExecState(this.nodes.values());
    const updateState = (action: execState.ExecAction) => execState.send(state, action);

    const processNode = async (node: Node): Promise<void> => {
      const { name, kind } = node;
      const badDep = execState.firstFailedDep(node, state);
      if (badDep) {
        updateState({
          type: "failure",
          node,
          hash: "",
          error: new Error(`dependency ${badDep} failed`),
        });
        progressCallback?.({
          node: name,
          kind,
          status: "dep-failed",
          error: `dependency ${badDep} failed`,
        });
        return;
      }

      const hash = computeHash(node, execState.depHashesFor(node, state));
      const [cachedResult, hit] = this.cache.get(hash);
      if (hit) {
        updateState({ type: "cache-hit", node, hash, cachedResult });
        progressCallback?.({ node: name, kind, status: "cached" });
        return;
      }

      progressCallback?.({ node: name, kind, status: "start" });
      const startTime = Date.now();
      try {
        const result = await runner(node, execState.inputsFor(node, state));
        this.cache.put(hash, result);
        updateState({ type: "success", node, hash, result });
        progressCallback?.({
          node: name,
          kind,
          status: "done",
          elapsed: Date.now() - startTime,
        });
      } catch (e) {
        updateState({ type: "failure", node, hash, error: e });
        const msg = e instanceof Error ? e.message : String(e);
        progressCallback?.({
          node: name,
          kind,
          status: "fail",
          elapsed: Date.now() - startTime,
          error: msg,
        });
      }
    };

    let resumeLoop: () => void = () => {};
    while (execState.hasWork(state)) {
      while (execState.canDispatch(state, maxParallelism)) {
        const node = execState.takeNext(state);
        processNode(node).finally(() => {
          updateState({ type: "complete", node });
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
