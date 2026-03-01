import { artwork, channelAvatar } from "@/pipeline/actions/artwork";
import { NodeKind } from "@/pipeline/actions/define-action";
import type { rssEntry } from "@/pipeline/actions/rss-entry";
import { publish } from "@/pipeline/publish";
import { parseExistingFeed } from "@/pipeline/rss/parse";
import type { Ports } from "@/ports/types";
import type { JsonPath } from "@/typed-path";
import { readJson } from "@/typed-path";
import type { Config, Episode, UploadEntry, VideoInfo } from "@/types";
import type { OutputOf } from "@podpiper/dagraph";
import type { HatchetClient, BaseWorkflowDeclaration } from "@hatchet-dev/typescript-sdk/v1";
import type { VideoInput } from "./adapter";
import { TASK_CONFIG } from "./task-config";

export function registerChannelWorkflow(
  hatchet: HatchetClient,
  channelName: string,
  config: Config,
  ports: Ports,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  videoPipeline: BaseWorkflowDeclaration<VideoInput, any>,
  schedule?: string,
) {
  const workflow = hatchet.workflow({
    name: `${channelName}-sync`,
    ...(schedule && { on: { cron: schedule } }),
  });

  const discover = workflow.task({
    name: "discover",
    fn: async () => {
      const allVideos = await ports.ytdlp.fetchVideoList(config.channelUrl);
      const feedData = await ports.storage.getFile(config.storage.bucket, "feed.xml");
      const existing = new Set<string>();
      if (feedData) {
        const episodes = parseExistingFeed(
          config.storage.publicUrl,
          new TextDecoder().decode(feedData),
        );
        for (const ep of episodes) existing.add(ep.id);
      }
      return { videos: allVideos.filter((v) => !existing.has(v.id)) };
    },
  });

  const processVideos = workflow.task({
    name: "process-videos",
    parents: [discover],
    fn: async (_input, ctx) => {
      const { videos } = (await ctx.parentOutput(discover)) as { videos: VideoInfo[] };
      const childResults = await Promise.all(
        videos.map(async (v) => {
          const result = await ctx.runChild(
            videoPipeline,
            { videoId: v.id, uploadDate: v.uploadDate, title: v.title },
            { additionalMetadata: { title: v.title } },
          );
          return { videoId: v.id, result: result as OutputOf<rssEntry> };
        }),
      );
      return { childResults };
    },
  });

  const avatarTask = workflow.task({
    name: "channel-avatar",
    parents: [discover],
    ...TASK_CONFIG[NodeKind.ChannelAvatar],
    fn: async () => {
      const actionFn = channelAvatar.createAction(ports);
      // Hatchet runs actions outside the DAG executor, so outputs use
      // fixed paths rather than executor-managed CAS directories.
      const outputDir = `${config.outputDir}/hatchet/channel_avatar`;
      return actionFn(
        { kind: NodeKind.ChannelAvatar, channelUrl: config.channelUrl },
        {},
        outputDir,
      );
    },
  });

  const artworkTask = workflow.task({
    name: "artwork",
    parents: [avatarTask],
    ...TASK_CONFIG[NodeKind.Artwork],
    fn: async (_input, ctx) => {
      const avatarPath = (await ctx.parentOutput(avatarTask)) as string;
      const actionFn = artwork.createAction(ports);
      const outputDir = `${config.outputDir}/hatchet/artwork`;
      return actionFn(
        {
          kind: NodeKind.Artwork,
          deps: { channelAvatar: { name: "" } },
        },
        { channelAvatar: avatarPath },
        outputDir,
      );
    },
  });

  workflow.task({
    name: "publish",
    parents: [processVideos, artworkTask],
    executionTimeout: "5m",
    fn: async (_input, ctx) => {
      const { childResults } = (await ctx.parentOutput(processVideos)) as {
        childResults: { videoId: string; result: OutputOf<rssEntry> }[];
      };
      const uploads: UploadEntry[] = [];
      const episodes: Episode[] = [];

      for (const { result } of childResults) {
        episodes.push(await readJson(ports.fs, result.episode));
        const entryUploads = await readJson(ports.fs, result.uploads);
        uploads.push(...entryUploads);
      }

      const artworkUploadsPath = (await ctx.parentOutput(artworkTask)) as JsonPath<UploadEntry[]>;
      const artworkUploads = await readJson(ports.fs, artworkUploadsPath);
      uploads.push(...artworkUploads);

      await publish({ uploads, episodes }, config, ports.fs, ports.storage);
    },
  });

  return workflow;
}
