import type { Cache, DagFs } from "./cache";
import { computeActionKey, hashOutputFiles, verifyOutputs } from "./content-addressing";
import type { Outputs, RunnableNode } from "./graph";
import type { ProcessNodeResult } from "./types";

/**
 * Stable execution infrastructure shared across invocations. The scheduler on
 * ExecuteOptions is separate because it varies per run while this context is long-lived.
 */
export interface ExecutionContext {
  cache: Cache;
  fs: DagFs;
  casBaseDir: string;
}

/**
 * Process a single DAG node: check deps, check cache, run action, cache result.
 * Can be called independently (e.g. as a Temporal activity) or wired into execute().
 */
export async function processNode(
  node: RunnableNode,
  depContentHashes: Map<string, string>,
  depOutputs: Record<string, Outputs>,
  ctx: ExecutionContext,
  opts?: { force?: boolean },
): Promise<ProcessNodeResult> {
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

  const actionKey = computeActionKey(node, depContentHashes);
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
    const outputs = await node.action(depOutputs, casDir);
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
