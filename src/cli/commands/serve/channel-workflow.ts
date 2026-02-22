import { artwork, channelAvatar, toArtworkUploadsFile } from "@/pipeline/actions/artwork";
import { NodeKind } from "@/pipeline/actions/define-action";
import { toEpisodeFile, toUploadsFile } from "@/pipeline/actions/rss-entry";
import { discoverVideos } from "@/pipeline/discovery";
import { publish } from "@/pipeline/publish";
import { parseExistingFeed } from "@/pipeline/rss/parse";
import type { Ports } from "@/ports/types";
import type { Config, Episode, UploadEntry, VideoInfo } from "@/types";
import type { HatchetClient, BaseWorkflowDeclaration } from "@hatchet-dev/typescript-sdk/v1";
import type { VideoInput } from "./adapter";

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
      const allVideos = await discoverVideos(config.channelUrl, ports.ytdlp);
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
      await Promise.all(
        videos.map((v) =>
          ctx.runChild(videoPipeline, {
            videoId: v.id,
            uploadDate: v.uploadDate,
            title: v.title,
          }),
        ),
      );
      return { videoIds: videos.map((v) => v.id) };
    },
  });

  const avatarTask = workflow.task({
    name: "channel-avatar",
    parents: [discover],
    retries: 3,
    executionTimeout: "5m",
    fn: async () => {
      const actionFn = channelAvatar.createAction(ports);
      const avatarDir = `${config.outputDir}/artwork`;
      return actionFn(
        { kind: NodeKind.ChannelAvatar, channelUrl: config.channelUrl, avatarDir },
        {},
      );
    },
  });

  const artworkTask = workflow.task({
    name: "artwork",
    parents: [avatarTask],
    executionTimeout: "2m",
    fn: async (_input, ctx) => {
      const avatarPath = (await ctx.parentOutput(avatarTask)) as string;
      const actionFn = artwork.createAction(ports);
      return actionFn(
        {
          kind: NodeKind.Artwork,
          artworkPath: `${config.outputDir}/artwork.jpg`,
          outputDir: config.outputDir,
          deps: { channel_avatar: { name: "" } },
        },
        { channel_avatar: avatarPath },
      );
    },
  });

  workflow.task({
    name: "publish",
    parents: [processVideos, artworkTask],
    executionTimeout: "5m",
    fn: async (_input, ctx) => {
      const { videoIds } = (await ctx.parentOutput(processVideos)) as { videoIds: string[] };
      const uploads: UploadEntry[] = [];
      const episodes: Episode[] = [];

      for (const videoId of videoIds) {
        episodes.push(await ports.fs.readJson(toEpisodeFile(config.outputDir, videoId)));
        const entryUploads: UploadEntry[] = await ports.fs.readJson(
          toUploadsFile(config.outputDir, videoId),
        );
        uploads.push(...entryUploads);
      }

      const artworkUploadsPath = toArtworkUploadsFile(config.outputDir);
      if (await ports.fs.exists(artworkUploadsPath)) {
        const artworkUploads: UploadEntry[] = await ports.fs.readJson(artworkUploadsPath);
        uploads.push(...artworkUploads);
      }

      await publish({ uploads, results: [], episodes }, config, ports.fs, ports.storage);
    },
  });

  return workflow;
}
