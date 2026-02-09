import type { ActionDef, ActionSpec } from "@/dag/define-action";
import { defineAction } from "@/dag/define-action";
import type { BaseParams } from "@/dag/types";
import type { Ports } from "@/ports/types";

export function defineActionWithPorts<P extends BaseParams, R>(
  spec: ActionSpec<Ports, P, R>,
): ActionDef<Ports, P, R> {
  return defineAction(spec);
}
