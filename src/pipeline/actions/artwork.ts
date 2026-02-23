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
  config: `avatar-v1,date=${new Date().toISOString().slice(0, 10)}`,
  action: (ports) => async (params, _inputs, outputDir) => {
    await ports.ytdlp.downloadChannelArtwork(outputDir, params.channelUrl);
    return `${outputDir}/channel_avatar.jpg`;
  },
});

export interface ArtworkParams {
  kind: typeof NodeKind.Artwork;
  deps: { channel_avatar: NodeRef<string> };
}

export const artwork = defineActionWithPorts<ArtworkParams, JsonPath<UploadEntry[]>>({
  name: (p) => p.kind,
  config: "artwork-v1",
  action: (ports) => async (_params, inputs, outputDir) => {
    const artworkPath = `${outputDir}/artwork.jpg`;
    await ports.ffmpeg.processChannelArtwork(inputs.channel_avatar, artworkPath);
    const uploads: UploadEntry[] = [
      { localPath: artworkPath, key: "artwork.jpg", cacheControl: "max-age=86400" },
    ];
    const uploadsPath = `${outputDir}/artwork-uploads.json`;
    await ports.fs.writeText(uploadsPath, JSON.stringify(uploads));
    return jsonPath<UploadEntry[]>(uploadsPath);
  },
});
