import type { NodeRef } from "@podpiper/dag/types";
import type { HasUploads } from "@/types";

import { NodeKind, defineActionWithPorts } from "./define-action";

export interface ArtworkOutput extends HasUploads {}

export interface ChannelAvatarParams {
  kind: typeof NodeKind.ChannelAvatar;
  channelUrl: string;
  avatarDir: string;
}

export const channelAvatar = defineActionWithPorts<ChannelAvatarParams, string>({
  name: (p) => p.kind,
  config: () => `avatar-v1,date=${new Date().toISOString().slice(0, 10)}`,
  action: (ports) => async (params) => {
    await ports.ytdlp.downloadChannelArtwork(params.avatarDir, params.channelUrl);
    return `${params.avatarDir}/channel_avatar.jpg`;
  },
});

export interface ArtworkParams {
  kind: typeof NodeKind.Artwork;
  artworkPath: string;
  deps: { channel_avatar: NodeRef<string> };
}

export const artwork = defineActionWithPorts<ArtworkParams, ArtworkOutput>({
  name: (p) => p.kind,
  config: "artwork-v1",
  action: (ports) => async (params, inputs) => {
    await ports.ffmpeg.processChannelArtwork(inputs.channel_avatar, params.artworkPath);
    return {
      uploads: [
        { localPath: params.artworkPath, r2Key: "artwork.jpg", cacheControl: "max-age=86400" },
      ],
    };
  },
});
