import { jsonPath, type JsonPath } from "@/typed-path";
import type { UploadEntry } from "@/types";
import type { NodeRef } from "@podpiper/dagraph";

import { NodeKind, defineActionWithPorts } from "./define-action";

export interface ChannelAvatarParams {
  kind: typeof NodeKind.ChannelAvatar;
  channelUrl: string;
}

export const channelAvatar = defineActionWithPorts<ChannelAvatarParams, string>({
  name: (p) => p.kind,
  // Date in config acts as a daily TTL — forces re-fetch since the avatar URL is
  // stable but the image behind it can change when the channel updates their profile.
  config: `avatar-v1,date=${new Date().toISOString().slice(0, 10)}`,
  action: (ports) => async (params, _inputs, outputDir) => {
    await ports.ytdlp.downloadChannelArtwork(outputDir, params.channelUrl);
    return `${outputDir}/channel_avatar.jpg`;
  },
});
export type channelAvatar = typeof channelAvatar;

export interface ArtworkParams {
  kind: typeof NodeKind.Artwork;
  deps: { channelAvatar: NodeRef<string> };
}

export const artwork = defineActionWithPorts<ArtworkParams, JsonPath<UploadEntry[]>>({
  name: (p) => p.kind,
  config: "artwork-v1",
  action: (ports) => async (_params, inputs, outputDir) => {
    const artworkPath = `${outputDir}/artwork.jpg`;
    await ports.ffmpeg.processChannelArtwork(inputs.channelAvatar, artworkPath);
    const uploads: UploadEntry[] = [
      { localPath: artworkPath, key: "artwork.jpg", cacheControl: "max-age=86400" },
    ];
    const uploadsPath = `${outputDir}/artwork-uploads.json`;
    await ports.fs.writeText(uploadsPath, JSON.stringify(uploads));
    return jsonPath<UploadEntry[]>(uploadsPath);
  },
});
export type artwork = typeof artwork;
