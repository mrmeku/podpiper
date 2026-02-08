import type { Graph } from "@/dag/graph";
import { addNode } from "@/dag/graph";
import { jsonRef } from "@/dag/types";
import type { ActionFunc, NodeRef } from "@/dag/types";
import type { MediaProcessor, YouTubeDownloader } from "@/ports/types";
import type { HasUploads } from "@/types";

import { NodeKind } from "./node-kind";

export interface ArtworkOutput extends HasUploads {}

export interface ChannelAvatarParams {
  kind: typeof NodeKind.ChannelAvatar;
  channelUrl: string;
  avatarDir: string;
}

export function channelAvatarAction(ytdlp: YouTubeDownloader): ActionFunc<ChannelAvatarParams> {
  return async (params) => {
    await ytdlp.downloadChannelArtwork(params.avatarDir, params.channelUrl);
    return `${params.avatarDir}/channel_avatar.jpg`;
  };
}

export interface ArtworkParams {
  kind: typeof NodeKind.Artwork;
  artworkPath: string;
  deps: { channel_avatar: string };
}

export function artworkAction(ffmpeg: MediaProcessor): ActionFunc<ArtworkParams> {
  return async (params, inputs) => {
    await ffmpeg.processChannelArtwork(inputs.channel_avatar, params.artworkPath);
    return JSON.stringify({
      uploads: [
        {
          localPath: params.artworkPath,
          r2Key: "artwork.jpg",
          cacheControl: "max-age=86400",
        },
      ],
    } satisfies ArtworkOutput);
  };
}

export function addArtworkNodes(
  graph: Graph,
  channelUrl: string,
  ytdlp: YouTubeDownloader,
  ffmpeg: MediaProcessor,
  outputDir: string,
): NodeRef<ArtworkOutput> {
  const avatarName = "channel_avatar";
  const artworkName = "artwork";
  const avatarDir = `${outputDir}/artwork`;
  const artworkPath = `${outputDir}/artwork.jpg`;

  addNode(graph, avatarName, `avatar-v1,date=${new Date().toISOString().slice(0, 10)}`, {
    kind: NodeKind.ChannelAvatar, channelUrl, avatarDir,
  } satisfies ChannelAvatarParams, channelAvatarAction(ytdlp));

  addNode(graph, artworkName, "artwork-v1", {
    kind: NodeKind.Artwork, artworkPath,
    deps: { channel_avatar: avatarName },
  } satisfies ArtworkParams, artworkAction(ffmpeg));

  return jsonRef<ArtworkOutput>(artworkName);
}
