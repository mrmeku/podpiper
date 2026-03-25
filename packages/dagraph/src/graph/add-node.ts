import type { ActionFunc, BaseParams, InputsFor, NodeRef, Outputs } from "./types";
import type { Graph } from "./graph";

/** Extract dependency node names from a params object's deps record. */
function depsFromParams(params: BaseParams): string[] {
  if (!params.deps) return [];
  return Object.values(params.deps)
    .filter((v) => v != null)
    .map((v) => v.name);
}

/** Map raw executor outputs (keyed by node name) to typed InputsFor<P> (keyed by dep role). */
function resolveInputs<P>(params: BaseParams, rawInputs: Record<string, Outputs>): InputsFor<P> {
  return Object.fromEntries(
    Object.entries(params.deps || [])
      .map(([role, ref]) => [role, ref && rawInputs[ref.name]])
      .filter((entry): entry is [string, Outputs] => entry[1] != null),
  ) as InputsFor<P>;
}

/**
 * Wire a typed action into a graph. Wraps the user's ActionFunc to resolve typed dep inputs
 * from raw executor-level outputs, then registers the resulting RunnableNode.
 */
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

