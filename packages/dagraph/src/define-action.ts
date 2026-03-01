/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Graph } from "./graph";
import { addNode as graphAddNode } from "./graph";
import type { ActionFunc, BaseParams, NodeRef, Outputs } from "./types";

export interface ActionSpec<Ctx, P extends BaseParams, R extends Outputs, C = string> {
  name: (params: P) => string;
  config: C;
  concurrencyGroup?: string;
  action: (ctx: Ctx, config: C) => ActionFunc<P, R>;
}

export interface ActionDef<Ctx, P extends BaseParams, R extends Outputs> {
  addNode: (graph: Graph, ctx: Ctx, params: P) => NodeRef<R>;
  createAction: (ctx: Ctx) => ActionFunc<P, R>;
}

/** Extract output type R from an ActionDef or a factory function that returns one. */
export type OutputOf<T> =
  T extends ActionDef<any, any, infer R>
    ? R
    : T extends (...args: any[]) => ActionDef<any, any, infer R>
      ? R
      : never;

/** Extract NodeRef<R> from an ActionDef or a factory function that returns one. */
export type NodeRefOf<T> = NodeRef<OutputOf<T>>;

function stableStringify(obj: unknown) {
  return JSON.stringify(obj, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

export function defineAction<Ctx, P extends BaseParams, R extends Outputs, C = string>(
  spec: ActionSpec<Ctx, P, R, C>,
): ActionDef<Ctx, P, R> {
  const configStr = typeof spec.config === "string" ? spec.config : stableStringify(spec.config);
  return {
    addNode: (graph, ctx, params) =>
      graphAddNode({
        graph,
        name: spec.name(params),
        config: configStr,
        ...(spec.concurrencyGroup && { concurrencyGroup: spec.concurrencyGroup }),
        params,
        action: spec.action(ctx, spec.config),
      }),
    createAction: (ctx) => spec.action(ctx, spec.config),
  };
}
