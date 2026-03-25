/**
 * Temporal workflow definitions.
 *
 * This file runs inside Temporal's V8 workflow sandbox — it must be deterministic
 * and cannot perform I/O directly. All I/O happens through activities.
 *
 * dagraph's orchestrate() is pure scheduling logic with no I/O, safe for the sandbox.
 */
import {
  executeChild,
  proxyActivities,
  type ActivityOptions,
} from "@temporalio/workflow";
import { orchestrate, unboundedScheduler, type Node, type Outputs, type RunNode } from "@podpiper/dagraph";

import type { Activities } from "./activities";
import { TEMPORAL_TASK_CONFIG, TASK_QUEUES } from "./task-config";
import type { NodeKind, VideoNodeKind } from "@/pipeline/actions/define-action";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

export interface VideoWorkflowInput {
  channelName: string;
  video: { videoId: string; uploadDate: string; title: string };
  descriptors: Node[];
}

export interface ChannelWorkflowInput {
  channelName: string;
}

function activityOptions(kind: string): ActivityOptions {
  return TEMPORAL_TASK_CONFIG[kind as NodeKind] ?? {
    taskQueue: TASK_QUEUES.default,
    startToCloseTimeout: "5m",
  };
}

export async function videoWorkflow(input: VideoWorkflowInput): Promise<Outputs | undefined> {
  const run: RunNode = async (desc, depContentHashes, depOutputs) => {
    const acts = proxyActivities<Activities>(activityOptions(desc.kind));
    const activity = acts[desc.kind as VideoNodeKind];
    return activity({
      channelName: input.channelName,
      video: input.video,
      nodeName: desc.name,
      kind: desc.kind,
      depContentHashes: Object.fromEntries(depContentHashes),
      depOutputs,
    });
  };
  const results = await orchestrate(input.descriptors, run, unboundedScheduler());
  const last = input.descriptors.at(-1);
  if (!last) return undefined;
  const result = results.find((r) => r.name === last.name);
  if (result && (result.status === "done" || result.status === "cached")) {
    return result.outputs;
  }
  return undefined;
}

/**
 * Channel-level workflow: discovers new videos, spawns child workflows per video,
 * fetches channel artwork, and publishes the feed.
 */
export async function channelWorkflow(input: ChannelWorkflowInput): Promise<void> {
  const defaultActs = proxyActivities<Activities>({
    taskQueue: TASK_QUEUES.default,
    startToCloseTimeout: "5m",
  });

  const { videos } = await defaultActs.discover({ channelName: input.channelName });
  if (videos.length === 0) return;

  const [videoResults, avatarPath] = await Promise.all([
    Promise.all(
      videos.map(({ video, descriptors }) =>
        executeChild<typeof videoWorkflow>("videoWorkflow", {
          workflowId: `${input.channelName}-${slugify(video.title)}-${video.id}`,
          taskQueue: TASK_QUEUES.workflows,
          args: [
            {
              channelName: input.channelName,
              video: { videoId: video.id, uploadDate: video.uploadDate, title: video.title },
              descriptors,
            },
          ],
        }),
      ),
    ),
    defaultActs.channelAvatarActivity({ channelName: input.channelName }),
  ]);

  const artworkOutputs = await defaultActs.artworkActivity({
    channelName: input.channelName,
    avatarPath,
  });

  const videoOutputs = videoResults.filter((r): r is Outputs => r != null);
  await defaultActs.collectAndPublish({
    channelName: input.channelName,
    videoOutputs,
    artworkOutputs,
  });
}
