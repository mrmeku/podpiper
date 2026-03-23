import type { ExecAction } from "./exec-state";
import { localRunner } from "./graph";
import { computeHash, hashOutputFiles, validateNoCycles, verifyOutputs } from "./helpers";
import type { RunNode, Scheduler } from "./orchestrate";
import { orchestrate } from "./orchestrate";
import { unboundedScheduler } from "./schedulers";
import type {
  Cache,
  DagFs,
  ExecResult,
  NodeRunner,
  Outputs,
  ProcessNodeResult,
  RunnableNode,
} from "./types";

import type { Graph } from "./graph";

/** Required infrastructure for execution — stable, typically shared across invocations (e.g. one
 * ExecutionContext for all Temporal activities in a channel). The runner parameter on execute() is separate
 * because it's the execution *strategy* that varies per invocation (Bazel: SpawnStrategy vs
 * ActionExecutionContext — different selection mechanisms, different lifetimes). */
export interface ExecutionContext {
  cache: Cache;
  fs: DagFs;
  casBaseDir: string;
}

/**
 * Process a single DAG node: check deps, check cache, run action, cache result.
 * Extracted from execute() so it can be called independently (e.g. as a Temporal activity).
 */
export async function processNode(
  node: RunnableNode,
  depContentHashes: Map<string, string>,
  depOutputs: Record<string, Outputs>,
  ctx: ExecutionContext,
  opts?: { runner?: NodeRunner; force?: boolean },
): Promise<ProcessNodeResult> {
  const runner = opts?.runner ?? localRunner;
  const force = opts?.force ?? false;

  for (const dep of node.deps) {
    if (!depContentHashes.has(dep)) {
      return {
        name: node.name,
        actionKey: "",
        status: "dep-failed",
        error: `dependency ${dep} failed`,
      };
    }
  }

  const actionKey = computeHash(node, depContentHashes);
  const casDir = `${ctx.casBaseDir}/${actionKey}`;

  const cached = !force ? await ctx.cache.get(actionKey) : undefined;
  if (cached && (await verifyOutputs(cached, ctx.fs.hashFile))) {
    return {
      name: node.name,
      actionKey,
      status: "cached",
      outputs: cached.outputs,
      contentHash: cached.contentHash,
    };
  }

  await ctx.fs.ensureDir(casDir);
  const startTime = Date.now();
  try {
    const outputs = await runner(node, depOutputs, casDir);
    const contentHash = await hashOutputFiles(outputs, ctx.fs.hashFile);
    await ctx.cache.put(actionKey, { outputs, contentHash });
    return {
      name: node.name,
      actionKey,
      status: "done",
      outputs,
      contentHash,
      elapsed: Date.now() - startTime,
    };
  } catch (e) {
    return {
      name: node.name,
      actionKey,
      status: "fail",
      error: e instanceof Error ? e.message : String(e),
      elapsed: Date.now() - startTime,
    };
  }
}

export interface ExecuteOptions {
  runner?: NodeRunner;
  force?: boolean;
  onAction?: (action: ExecAction) => void;
  scheduler?: Scheduler;
}

export async function execute(
  graph: Graph,
  ctx: ExecutionContext,
  opts?: ExecuteOptions,
): Promise<ExecResult[]> {
  const nodes = graph.getNodes();
  validateNoCycles(nodes);
  const runner = opts?.runner ?? localRunner;
  const force = opts?.force ?? false;
  const scheduler = opts?.scheduler ?? unboundedScheduler();
  const run: RunNode = (desc, depContentHashes, depOutputs) => {
    const node = nodes.get(desc.name)!;
    return processNode(node, depContentHashes, depOutputs, ctx, { runner, force });
  };
  return orchestrate(nodes.values(), run, scheduler, opts?.onAction);
}
