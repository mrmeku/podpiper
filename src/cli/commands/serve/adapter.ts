import type { CreateWorkflowTaskOpts, HatchetClient } from "@hatchet-dev/typescript-sdk/v1";
import type { ExecutionContext } from "@podpiper/dag/execute";
import { execute } from "@podpiper/dag/execute";
import type { KindEdge, NodeRunner } from "@podpiper/dag/types";

import type { NodeKind } from "@/pipeline/actions/define-action";
import { toVideoActionName } from "@/pipeline/actions/define-action";
import { buildVideoGraph } from "@/pipeline/graph-builder";
import type { Ports } from "@/ports/types";
import type { Config, VideoInfo } from "@/types";
import { TASK_CONFIG } from "./task-config";

export type VideoInput = {
  videoId: string;
  uploadDate: string;
  title: string;
};

type VideoTaskRef = CreateWorkflowTaskOpts<VideoInput, Record<string, string | string[]>>;

export function toHatchetVideoWorkflow(
  hatchet: HatchetClient,
  name: string,
  topology: KindEdge[],
  ports: Ports,
  config: Config,
  executionCtx: ExecutionContext,
) {
  const workflow = hatchet.workflow<VideoInput>({ name });
  const taskRefs = new Map<string, VideoTaskRef>();

  for (const edge of topology) {
    const parents = edge.depKinds
      .map((kind) => taskRefs.get(kind))
      .filter((ref): ref is VideoTaskRef => ref != null);
    const kind = edge.kind as NodeKind;
    const ref = workflow.task({
      name: kind,
      parents,
      ...TASK_CONFIG[kind],
      fn: async (input: VideoInput, ctx) => {
        const video: VideoInfo = {
          id: input.videoId,
          uploadDate: input.uploadDate,
          title: input.title,
        };
        const graph = buildVideoGraph(video, ports, config);
        const targetName = toVideoActionName({ kind, videoId: input.videoId });

        const runner: NodeRunner = (node, inputs) => {
          if (node.name === targetName) return node.action(inputs);
          const parentTask = taskRefs.get(node.kind);
          if (parentTask) return ctx.parentOutput(parentTask);
          throw new Error(`skip: ${node.name}`);
        };

        const results = await execute(graph, executionCtx, runner);
        const result = results.find((r) => r.name === targetName)!;
        if (result.status === "fail") throw result.error;
        if (result.status === "dep-failed") throw result.error;
        return result.outputs;
      },
    });
    taskRefs.set(kind, ref);
  }

  return workflow;
}
