import type {
  AnalysisResult,
  AnalyzedNode,
  Cache,
  ExecResult,
  ExecuteOptions,
  Node,
  NodeRunner,
} from "./types";

import * as execState from "./exec-state";
import { computeHash, toCounts, validateNoCycles } from "./helpers";

export const localRunner: NodeRunner = (node, inputs) => node.action(inputs);

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
    const { maxParallelism, onProgress: emit } = opts ?? {};
    const state = execState.createExecState(this.nodes.values());

    const processNode = async (node: Node): Promise<void> => {
      const { name, kind } = node;
      const badDep = execState.firstFailedDep(node, state);
      if (badDep) {
        execState.send(state, { type: "failure", node, hash: "", error: new Error(`dependency ${badDep} failed`) });
        emit?.({ node: name, kind, status: "dep-failed", error: `dependency ${badDep} failed` });
        return;
      }

      const hash = computeHash(node, execState.depHashesFor(node, state));
      const [cachedResult, hit] = this.cache.get(hash);
      if (hit) {
        execState.send(state, { type: "cache-hit", node, hash, cachedResult });
        emit?.({ node: name, kind, status: "cached" });
        return;
      }

      emit?.({ node: name, kind, status: "start" });
      const startTime = Date.now();
      try {
        const result = await runner(node, execState.inputsFor(node, state));
        this.cache.put(hash, result);
        execState.send(state, { type: "success", node, hash, result });
        emit?.({ node: name, kind, status: "done", elapsed: Date.now() - startTime });
      } catch (e) {
        execState.send(state, { type: "failure", node, hash, error: e });
        const msg = e instanceof Error ? e.message : String(e);
        emit?.({ node: name, kind, status: "fail", elapsed: Date.now() - startTime, error: msg });
      }
    };

    let resumeLoop: () => void = () => {};
    while (execState.hasWork(state)) {
      while (execState.canDispatch(state, maxParallelism)) {
        const node = execState.takeNext(state);
        processNode(node).finally(() => {
          execState.send(state,{ type: "complete", node });
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
