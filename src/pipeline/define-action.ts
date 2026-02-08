import type { Graph } from "@/dag/graph";
import { addNode as graphAddNode } from "@/dag/graph";
import type { ActionFunc, BaseParams, NodeRef } from "@/dag/types";
import type { Ports } from "@/ports/types";

interface ActionSpec<P extends BaseParams, R> {
  name: (params: P) => string;
  config: string | ((params: P) => string);
  action: (ports: Ports) => ActionFunc<P, R>;
}

interface ActionDef<P extends BaseParams, R> {
  action: (ports: Ports) => ActionFunc<P, R>;
  addNode: (graph: Graph, ports: Ports, params: P) => NodeRef<R>;
}

export function defineAction<P extends BaseParams, R>(spec: ActionSpec<P, R>): ActionDef<P, R> {
  return {
    action: spec.action,
    addNode: (graph, ports, params) => {
      const config = typeof spec.config === "string" ? spec.config : spec.config(params);
      return graphAddNode(graph, spec.name(params), config, params, spec.action(ports));
    },
  };
}
