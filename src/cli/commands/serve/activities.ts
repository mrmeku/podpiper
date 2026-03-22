import { artwork, channelAvatar } from "@/pipeline/actions/artwork";
import { NodeKind } from "@/pipeline/actions/define-action";
import type { rssEntry } from "@/pipeline/actions/rss-entry";
import { buildVideoGraph } from "@/pipeline/graph-builder";
import { publish } from "@/pipeline/publish";
import { parseExistingFeed } from "@/pipeline/rss/parse";
import type { Ports } from "@/ports/types";
import { readJson } from "@/typed-path";
import type { Config, Episode, UploadEntry, VideoInfo } from "@/types";
import {
  processNode,
  type ExecutionContext,
  type Node,
  type OutputOf,
  type Outputs,
  type ProcessNodeResult,
} from "@podpiper/dagraph";

export interface VideoNodeInput {
  video: { videoId: string; uploadDate: string; title: string };
  nodeName: string;
  kind: string;
  depContentHashes: Record<string, string>;
  depOutputs: Record<string, Outputs>;
}

export interface DiscoverResult {
  videos: Array<{ video: VideoInfo; descriptors: Node[] }>;
}

export interface CollectAndPublishInput {
  videoOutputs: Outputs[];
  artworkOutputs: Outputs;
}

export function createActivities(ports: Ports, config: Config, executionCtx: ExecutionContext) {
  return {
    async processVideoNode(input: VideoNodeInput): Promise<ProcessNodeResult> {
      const video: VideoInfo = {
        id: input.video.videoId,
        uploadDate: input.video.uploadDate,
        title: input.video.title,
      };
      const graph = buildVideoGraph(video, ports, config);
      const node = graph.getNodes().get(input.nodeName)!;
      return processNode(
        node,
        new Map(Object.entries(input.depContentHashes)),
        input.depOutputs,
        executionCtx,
      );
    },

    async discover(): Promise<DiscoverResult> {
      const allVideos = await ports.ytdlp.fetchVideoList(config);
      const feedData = await ports.storage.getFile(config.storage.bucket, "feed.xml");
      const existing = new Set<string>();
      if (feedData) {
        const episodes = parseExistingFeed(
          config.storage.publicUrl,
          new TextDecoder().decode(feedData),
        );
        for (const ep of episodes) existing.add(ep.id);
      }
      const newVideos = allVideos.filter((v) => !existing.has(v.id));
      return {
        videos: newVideos.map((v) => ({
          video: v,
          descriptors: buildVideoGraph(v, ports, config).describe(),
        })),
      };
    },

    async channelAvatarActivity(): Promise<string> {
      const actionFn = channelAvatar.createAction(ports);
      const outputDir = `${config.outputDir}/temporal/channel_avatar`;
      return actionFn(
        { kind: NodeKind.ChannelAvatar, channelUrl: config.channelUrl },
        {},
        outputDir,
      );
    },

    async artworkActivity(avatarPath: string): Promise<Outputs> {
      const actionFn = artwork.createAction(ports);
      const outputDir = `${config.outputDir}/temporal/artwork`;
      return actionFn(
        {
          kind: NodeKind.Artwork,
          deps: { channelAvatar: { name: "" } },
        },
        { channelAvatar: avatarPath },
        outputDir,
      );
    },

    async collectAndPublish(input: CollectAndPublishInput): Promise<void> {
      const uploads: UploadEntry[] = [];
      const episodes: Episode[] = [];

      for (const output of input.videoOutputs) {
        const paths = output as OutputOf<rssEntry>;
        episodes.push(await readJson(ports.fs, paths.episode));
        const entryUploads = await readJson(ports.fs, paths.uploads);
        uploads.push(...entryUploads);
      }

      const artworkUploadsPath = input.artworkOutputs as OutputOf<typeof artwork>;
      const artworkUploads = await readJson(ports.fs, artworkUploadsPath);
      uploads.push(...artworkUploads);

      await publish({ uploads, episodes }, config, ports.fs, ports.storage, ports.clock.now);
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;
