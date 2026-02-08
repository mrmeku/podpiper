import type { Graph } from "@/dag/graph";
import { addNode } from "@/dag/graph";
import type { ActionFunc, DepName, NodeRef } from "@/dag/types";
import { dep } from "@/dag/types";
import type { MediaProcessor, YouTubeDownloader } from "@/ports/types";
import type { HasUploads } from "@/types";

import { NodeKind } from "./node-kind";

export interface ArtworkOutput extends HasUploads {}

export interface ChannelAvatarParams {
  kind: typeof NodeKind.ChannelAvatar;
  channelUrl: string;
  avatarDir: string;
}

export function channelAvatarAction(ytdlp: YouTubeDownloader): ActionFunc<ChannelAvatarParams, string> {
  return async (params) => {
    await ytdlp.downloadChannelArtwork(params.avatarDir, params.channelUrl);
    return `${params.avatarDir}/channel_avatar.jpg`;
  };
}

export interface ArtworkParams {
  kind: typeof NodeKind.Artwork;
  artworkPath: string;
  deps: { channel_avatar: DepName<string> };
}

export function artworkAction(ffmpeg: MediaProcessor): ActionFunc<ArtworkParams, ArtworkOutput> {
  return async (params, inputs) => {
    await ffmpeg.processChannelArtwork(inputs.channel_avatar, params.artworkPath);
    return {
      uploads: [
        {
          localPath: params.artworkPath,
          r2Key: "artwork.jpg",
          cacheControl: "max-age=86400",
        },
      ],
    };
  };
}

export function addArtworkNodes(
  graph: Graph,
  channelUrl: string,
  ytdlp: YouTubeDownloader,
  ffmpeg: MediaProcessor,
  outputDir: string,
): NodeRef<ArtworkOutput> {
  const avatarDir = `${outputDir}/artwork`;
  const artworkPath = `${outputDir}/artwork.jpg`;

  const avatarRef = addNode(graph, "channel_avatar", `avatar-v1,date=${new Date().toISOString().slice(0, 10)}`, {
    kind: NodeKind.ChannelAvatar, channelUrl, avatarDir,
  } satisfies ChannelAvatarParams, channelAvatarAction(ytdlp));

  return addNode(graph, "artwork", "artwork-v1", {
    kind: NodeKind.Artwork, artworkPath,
    deps: { channel_avatar: dep(avatarRef) },
  } satisfies ArtworkParams, artworkAction(ffmpeg));
}
