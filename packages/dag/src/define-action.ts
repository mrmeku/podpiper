import type { Graph } from "./graph";
import { addNode as graphAddNode } from "./graph";
import type { ActionFunc, BaseParams, NodeRef, Outputs } from "./types";

export interface ActionSpec<Ctx, P extends BaseParams, R extends Outputs, C = string> {
  name: (params: P) => string;
  config: C;
  action: (ctx: Ctx, config: C) => ActionFunc<P, R>;
}

export interface ActionDef<Ctx, P extends BaseParams, R extends Outputs> {
  addNode: (graph: Graph, ctx: Ctx, params: P) => NodeRef<R>;
}

export function defineAction<Ctx, P extends BaseParams, R extends Outputs, C = string>(
  spec: ActionSpec<Ctx, P, R, C>,
): ActionDef<Ctx, P, R> {
  const configStr = typeof spec.config === "string"
    ? spec.config
    : JSON.stringify(spec.config);
  return {
    addNode: (graph, ctx, params) =>
      graphAddNode(graph, spec.name(params), configStr, params, spec.action(ctx, spec.config)),
  };
}
