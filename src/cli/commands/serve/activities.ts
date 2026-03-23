import { artwork, channelAvatar } from "@/pipeline/actions/artwork";
import { ChannelNodeKind, VideoNodeKind } from "@/pipeline/actions/define-action";
import type { rssEntry } from "@/pipeline/actions/rss-entry";
import { buildVideoGraph } from "@/pipeline/graph-builder";
import { publish } from "@/pipeline/publish";
import { parseExistingFeed } from "@/pipeline/rss/parse";
import type { Ports } from "@/ports/types";
import { readJson } from "@/typed-path";
import type { Config, Episode, UploadEntry, VideoInfo } from "@/types";
import { getConfig } from "@/config";
import {
  FsCache,
  processNode,
  type Node,
  type OutputOf,
  type Outputs,
  type ProcessNodeResult,
} from "@podpiper/dagraph";

export interface VideoNodeInput {
  channelName: string;
  video: { videoId: string; uploadDate: string; title: string };
  nodeName: string;
  kind: string;
  depContentHashes: Record<string, string>;
  depOutputs: Record<string, Outputs>;
}

export interface DiscoverInput {
  channelName: string;
}

export interface DiscoverResult {
  videos: Array<{ video: VideoInfo; descriptors: Node[] }>;
}

export interface ChannelAvatarInput {
  channelName: string;
}

export interface ArtworkInput {
  channelName: string;
  avatarPath: string;
}

export interface CollectAndPublishInput {
  channelName: string;
  videoOutputs: Outputs[];
  artworkOutputs: Outputs;
}

export type ConfigResolver = (channelName: string) => Config;

function defaultResolve(ports: Ports, configResolver: ConfigResolver, channelName: string) {
  const config = configResolver(channelName);
  const cache = new FsCache(config.casBaseDir, ports.fs);
  return { config, executionCtx: { cache, fs: ports.fs, casBaseDir: config.casBaseDir } };
}

type VideoNodeActivities = Record<VideoNodeKind, (input: VideoNodeInput) => Promise<ProcessNodeResult>>;

export function createActivities(ports: Ports, configResolver: ConfigResolver = getConfig) {
  async function runVideoNode(input: VideoNodeInput): Promise<ProcessNodeResult> {
    const { config, executionCtx } = defaultResolve(ports, configResolver, input.channelName);
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
  }

  const videoNodeActivities = Object.fromEntries(
    Object.values(VideoNodeKind).map((kind) => [kind, runVideoNode]),
  ) as VideoNodeActivities;

  return {
    ...videoNodeActivities,

    async discover(input: DiscoverInput): Promise<DiscoverResult> {
      const { config } = defaultResolve(ports, configResolver, input.channelName);
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

    async channelAvatarActivity(input: ChannelAvatarInput): Promise<string> {
      const { config } = defaultResolve(ports, configResolver, input.channelName);
      const actionFn = channelAvatar.createAction(ports);
      const outputDir = `${config.outputDir}/temporal/channel_avatar`;
      await ports.fs.ensureDir(outputDir);
      return actionFn(
        { kind: ChannelNodeKind.ChannelAvatar, channelUrl: config.channelUrl },
        {},
        outputDir,
      );
    },

    async artworkActivity(input: ArtworkInput): Promise<Outputs> {
      const { config } = defaultResolve(ports, configResolver, input.channelName);
      const actionFn = artwork.createAction(ports);
      const outputDir = `${config.outputDir}/temporal/artwork`;
      await ports.fs.ensureDir(outputDir);
      return actionFn(
        {
          kind: ChannelNodeKind.Artwork,
          deps: { channelAvatar: { name: "" } },
        },
        { channelAvatar: input.avatarPath },
        outputDir,
      );
    },

    async collectAndPublish(input: CollectAndPublishInput): Promise<void> {
      const { config } = defaultResolve(ports, configResolver, input.channelName);
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
