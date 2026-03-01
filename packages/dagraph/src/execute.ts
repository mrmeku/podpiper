import * as execState from "./exec-state";
import { localRunner } from "./graph";
import { computeHash, hashOutputFiles, validateNoCycles, verifyOutputs } from "./helpers";
import type { Cache, DagFs, ExecResult, ExecuteOptions, Node, NodeRunner } from "./types";

import type { Graph } from "./graph";

/** Required infrastructure for execution — stable, typically shared across invocations (e.g. one
 * ExecutionContext for all Hatchet tasks in a channel). The runner parameter on execute() is separate
 * because it's the execution *strategy* that varies per invocation (Bazel: SpawnStrategy vs
 * ActionExecutionContext — different selection mechanisms, different lifetimes). */
export interface ExecutionContext {
  cache: Cache;
  fs: DagFs;
  casBaseDir: string;
}

export async function execute(
  graph: Graph,
  ctx: ExecutionContext,
  runner: NodeRunner = localRunner,
  opts?: ExecuteOptions,
): Promise<ExecResult[]> {
  const { maxParallelism, concurrencyLimits, onAction } = opts ?? {};
  const nodes = graph.getNodes();
  validateNoCycles(nodes);
  const state = execState.createExecState(nodes.values());
  const dispatch = (action: execState.ExecAction) => {
    execState.send(state, action);
    onAction?.(action);
  };

  const processNode = async (node: Node): Promise<void> => {
    const failedDep = execState.failedDep(node, state);
    if (failedDep) {
      dispatch({
        type: "dep-failed",
        node,
        error: new Error(`dependency ${failedDep} failed`),
      });
      return;
    }

    const depContentHashes = new Map(node.deps.map((d) => [d, state.contentHashes.get(d)!]));
    const actionKey = computeHash(node, depContentHashes);
    const casDir = `${ctx.casBaseDir}/${actionKey}`;

    const cached = await ctx.cache.get(actionKey);
    if (cached && (await verifyOutputs(cached, ctx.fs.hashFile))) {
      dispatch({
        type: "cached",
        node,
        actionKey,
        outputs: cached.outputs,
        contentHash: cached.contentHash,
      });
      return;
    }

    await ctx.fs.ensureDir(casDir);
    dispatch({ type: "start", node });
    const startTime = Date.now();
    try {
      const outputs = await runner(node, execState.inputsFor(node, state), casDir);
      const contentHash = await hashOutputFiles(outputs, ctx.fs.hashFile);
      await ctx.cache.put(actionKey, { outputs, contentHash });
      dispatch({
        type: "done",
        node,
        actionKey,
        outputs,
        contentHash,
        elapsed: Date.now() - startTime,
      });
    } catch (e) {
      dispatch({ type: "fail", node, error: e, elapsed: Date.now() - startTime });
    }
  };

  let resumeLoop: () => void = () => {};
  while (execState.hasWork(state)) {
    let node: Node | null;
    while ((node = execState.tryTakeNext(state, maxParallelism, concurrencyLimits))) {
      const captured = node;
      processNode(captured).finally(() => {
        dispatch({ type: "complete", node: captured });
        resumeLoop();
      });
    }
    await new Promise<void>((r) => {
      resumeLoop = r;
    });
  }

  return [...state.execResults.values()];
}
