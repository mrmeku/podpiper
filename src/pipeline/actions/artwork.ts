import { jsonPath, type JsonPath } from "@/typed-path";
import type { UploadEntry } from "@/types";
import type { NodeRef } from "@podpiper/dag/types";

import { NodeKind, defineActionWithPorts } from "./define-action";

export interface ChannelAvatarParams {
  kind: typeof NodeKind.ChannelAvatar;
  channelUrl: string;
  avatarDir: string;
}

export const channelAvatar = defineActionWithPorts<ChannelAvatarParams, string>({
  name: (p) => p.kind,
  config: `avatar-v1,date=${new Date().toISOString().slice(0, 10)}`,
  action: (ports) => async (params) => {
    await ports.ytdlp.downloadChannelArtwork(params.avatarDir, params.channelUrl);
    return `${params.avatarDir}/channel_avatar.jpg`;
  },
});

export interface ArtworkParams {
  kind: typeof NodeKind.Artwork;
  artworkPath: string;
  outputDir: string;
  deps: { channel_avatar: NodeRef<string> };
}

export function toArtworkUploadsFile(outputDir: string): string {
  return `${outputDir}/artwork-uploads.json`;
}

export const artwork = defineActionWithPorts<ArtworkParams, JsonPath<UploadEntry[]>>({
  name: (p) => p.kind,
  config: "artwork-v1",
  action: (ports) => async (params, inputs) => {
    await ports.ffmpeg.processChannelArtwork(inputs.channel_avatar, params.artworkPath);
    const uploads: UploadEntry[] = [
      { localPath: params.artworkPath, r2Key: "artwork.jpg", cacheControl: "max-age=86400" },
    ];
    const outputPath = toArtworkUploadsFile(params.outputDir);
    await ports.fs.writeText(outputPath, JSON.stringify(uploads));
    return jsonPath<UploadEntry[]>(outputPath);
  },
});
