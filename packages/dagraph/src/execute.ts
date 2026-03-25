import type { ExecEvent, ExecResult } from "./exec-state";
import type { Graph } from "./graph";
import { validateNoCycles } from "./graph";
import type { RunNode, Scheduler } from "./orchestrate";
import { orchestrate } from "./orchestrate";
import { processNode, type ExecutionContext } from "./process-node";
import { unboundedScheduler } from "./schedulers";

export { processNode, type ExecutionContext } from "./process-node";

/**
 * Per-invocation overrides for DAG execution. Separate from ExecutionContext because these vary
 * per run (e.g. --force for a retry) while the context is stable infrastructure.
 */
export interface ExecuteOptions {
  force?: boolean;
  onEvent?: (event: ExecEvent) => void;
  scheduler?: Scheduler;
}

/**
 * Run an entire DAG to completion. This is the primary entry point for dagraph — call it with a
 * built Graph, an ExecutionContext (cache + fs), and optional scheduling overrides. Returns
 * per-node results (done, cached, fail, dep-failed).
 */
export async function execute(
  graph: Graph,
  ctx: ExecutionContext,
  opts?: ExecuteOptions,
): Promise<ExecResult[]> {
  const nodes = graph.getNodes();
  validateNoCycles(nodes);
  const force = opts?.force ?? false;
  const scheduler = opts?.scheduler ?? unboundedScheduler();
  const run: RunNode = (desc, depContentHashes, depOutputs) => {
    const node = nodes.get(desc.name)!;
    return processNode(node, depContentHashes, depOutputs, ctx, { force });
  };
  return orchestrate(nodes.values(), run, scheduler, opts?.onEvent);
}
