/* eslint-disable @typescript-eslint/no-explicit-any */
import { addNode, type Graph, type ActionFunc, type BaseParams, type NodeRef, type Outputs } from "./graph";

/**
 * Bound action ready to wire into a graph. Call addNode() to register it in a Graph, or
 * createAction() to get the raw function (useful for testing or Temporal activity registration).
 */
export interface Action<Ctx, P extends BaseParams, R extends Outputs> {
  addNode: (graph: Graph, ctx: Ctx, params: P) => NodeRef<R>;
  createAction: (ctx: Ctx) => ActionFunc<P, R>;
}

/** Extract output type R from an Action or a factory function that returns one. */
export type OutputOf<T> =
  T extends Action<any, any, infer R>
    ? R
    : T extends (...args: any[]) => Action<any, any, infer R>
      ? R
      : never;

/** Extract NodeRef<R> from an Action or a factory function that returns one. */
export type NodeRefOf<T> = NodeRef<OutputOf<T>>;

/**
 * JSON.stringify with sorted object keys — ensures identical config objects always produce the
 * same string regardless of property insertion order.
 */
function deterministicStringify(obj: unknown) {
  return JSON.stringify(obj, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

/**
 * Create a reusable action from a spec. Serializes config deterministically so that
 * config changes invalidate the cache. The returned Action can add nodes to any number of graphs.
 */
export function defineAction<Ctx, P extends BaseParams, R extends Outputs, C = string>(
  spec: {
    config: C;
    concurrencyGroup?: string;
    action: (ctx: Ctx, config: C) => ActionFunc<P, R>;
  },
): Action<Ctx, P, R> {
  const configStr = typeof spec.config === "string" ? spec.config : deterministicStringify(spec.config);
  return {
    addNode: (graph, ctx, params) =>
      addNode({
        graph,
        name: params.kind,
        config: configStr,
        ...(spec.concurrencyGroup && { concurrencyGroup: spec.concurrencyGroup }),
        params,
        action: spec.action(ctx, spec.config),
      }),
    createAction: (ctx) => spec.action(ctx, spec.config),
  };
}
