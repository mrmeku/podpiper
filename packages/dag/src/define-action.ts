import type { Graph } from "./graph";
import { addNode as graphAddNode } from "./graph";
import type { ActionFunc, BaseParams, NodeRef } from "./types";

export interface ActionSpec<Ctx, P extends BaseParams, R> {
  name: (params: P) => string;
  config: string | ((params: P) => string);
  action: (ctx: Ctx) => ActionFunc<P, R>;
}

export interface ActionDef<Ctx, P extends BaseParams, R> {
  action: (ctx: Ctx) => ActionFunc<P, R>;
  addNode: (graph: Graph, ctx: Ctx, params: P) => NodeRef<R>;
}

export function defineAction<Ctx, P extends BaseParams, R>(spec: ActionSpec<Ctx, P, R>): ActionDef<Ctx, P, R> {
  return {
    action: spec.action,
    addNode: (graph, ctx, params) => {
      const config = typeof spec.config === "string" ? spec.config : spec.config(params);
      return graphAddNode(graph, spec.name(params), config, params, spec.action(ctx));
    },
  };
}
