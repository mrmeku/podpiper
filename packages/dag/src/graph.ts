import type {
  ActionFunc,
  AnalysisResult,
  BaseParams,
  Cache,
  ExecResult,
  ExecuteOptions,
  InputsFor,
  Node,
  NodeRef,
  NodeRunner,
  Outputs,
} from "./types";

import * as execState from "./exec-state";
import {
  type HashFileFn,
  computeHash,
  hashOutputFiles,
  validateNoCycles,
  verifyOutputs,
} from "./helpers";

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
    action: (rawInputs) => action(params, resolveInputs<P>(params, rawInputs)),
  });
  return { name };
}

export const localRunner: NodeRunner = (node, rawInputs) => node.action(rawInputs);

export class Graph {
  private nodes = new Map<string, Node>();
  private hashFile: HashFileFn;
  constructor(
    private cache: Cache,
    hashFile: HashFileFn,
  ) {
    this.hashFile = hashFile;
  }

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

  async execute(runner: NodeRunner = localRunner, opts?: ExecuteOptions): Promise<ExecResult[]> {
    const { maxParallelism, onAction } = opts ?? {};
    const state = execState.createExecState(this.nodes.values());
    const dispatch = (action: execState.ExecAction) => {
      execState.send(state, action);
      onAction?.(action);
    };

    const processNode = async (node: Node): Promise<void> => {
      const failedDep = execState.failedTransitiveDep(node, state);
      if (failedDep) {
        dispatch({
          type: "dep-failure",
          node,
          error: new Error(`dependency ${failedDep} failed`),
        });
        return;
      }

      const depContentHashes = new Map(node.deps.map((d) => [d, state.contentHashes.get(d)!]));
      const actionKey = computeHash(node, depContentHashes);

      const cached = await this.cache.get(actionKey);
      if (cached && (await verifyOutputs(cached, this.hashFile))) {
        dispatch({
          type: "cache-hit",
          node,
          actionKey,
          outputs: cached.outputs,
          contentHash: cached.contentHash,
        });
        return;
      }

      dispatch({ type: "start", node });
      const startTime = Date.now();
      try {
        const outputs = await runner(node, execState.inputsFor(node, state));
        const contentHash = await hashOutputFiles(outputs, this.hashFile);
        await this.cache.put(actionKey, { outputs, contentHash });
        dispatch({
          type: "success",
          node,
          actionKey,
          outputs,
          contentHash,
          elapsed: Date.now() - startTime,
        });
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

    return [...state.execResults.values()];
  }
}
