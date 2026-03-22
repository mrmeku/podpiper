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
import { orchestrate, type Node, type Outputs, type RunNode } from "@podpiper/dagraph";

import type { Activities } from "./activities";
import { TEMPORAL_TASK_CONFIG, TASK_QUEUES } from "./task-config";
import type { NodeKind } from "@/pipeline/actions/define-action";

export interface VideoWorkflowInput {
  video: { videoId: string; uploadDate: string; title: string };
  descriptors: Node[];
}

export interface ChannelWorkflowInput {
  channelName: string;
}

function activityOptions(kind: string): ActivityOptions {
  const cfg = TEMPORAL_TASK_CONFIG[kind as NodeKind];
  if (!cfg) {
    return {
      taskQueue: TASK_QUEUES.default,
      startToCloseTimeout: "5m",
    };
  }
  return {
    taskQueue: cfg.taskQueue,
    startToCloseTimeout: cfg.startToCloseTimeout,
    ...(cfg.scheduleToCloseTimeout && { scheduleToCloseTimeout: cfg.scheduleToCloseTimeout }),
    ...(cfg.retry && {
      retry: {
        ...(cfg.retry.maximumAttempts != null && { maximumAttempts: cfg.retry.maximumAttempts }),
        ...(cfg.retry.backoffCoefficient != null && { backoffCoefficient: cfg.retry.backoffCoefficient }),
        ...(cfg.retry.maximumInterval != null && { maximumInterval: cfg.retry.maximumInterval }),
      },
    }),
  };
}

export async function videoWorkflow(input: VideoWorkflowInput): Promise<Outputs | undefined> {
  const run: RunNode = async (desc, depContentHashes, depOutputs) => {
    const acts = proxyActivities<Activities>(activityOptions(desc.kind));
    return acts.processVideoNode({
      video: input.video,
      nodeName: desc.name,
      kind: desc.kind,
      depContentHashes: Object.fromEntries(depContentHashes),
      depOutputs,
    });
  };
  const results = await orchestrate(input.descriptors, run);
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

  // 1. Discover new videos
  const { videos } = await defaultActs.discover();
  if (videos.length === 0) return;

  // 2. Spawn child workflow per video + channel avatar in parallel
  const [videoResults, avatarPath] = await Promise.all([
    Promise.all(
      videos.map(({ video, descriptors }) =>
        executeChild<typeof videoWorkflow>("videoWorkflow", {
          workflowId: `${input.channelName}-video-${video.id}`,
          taskQueue: TASK_QUEUES.workflows,
          args: [
            {
              video: { videoId: video.id, uploadDate: video.uploadDate, title: video.title },
              descriptors,
            },
          ],
        }),
      ),
    ),
    defaultActs.channelAvatarActivity(),
  ]);

  // 3. Process artwork (depends on avatar)
  const artworkOutputs = await defaultActs.artworkActivity(avatarPath);

  // 4. Collect episode data from video results and publish
  const videoOutputs = videoResults.filter((r): r is Outputs => r != null);
  await defaultActs.collectAndPublish({ videoOutputs, artworkOutputs });
}
