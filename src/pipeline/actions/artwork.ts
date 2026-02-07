import type { Graph } from "@/dag/graph";
import { jsonRef } from "@/dag/types";
import type { NodeRef } from "@/dag/types";
import type { MediaProcessor, YouTubeDownloader } from "@/ports/types";
import type { HasUploads } from "@/types";

export interface ArtworkOutput extends HasUploads {}

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

  graph.add({
    name: avatarName,
    deps: [],
    config: `avatar-v1,date=${new Date().toISOString().slice(0, 10)}`,
    action: async () => {
      await ytdlp.downloadChannelArtwork(avatarDir, channelUrl);
      return `${avatarDir}/channel_avatar.jpg`;
    },
  });

  graph.add({
    name: artworkName,
    deps: [avatarName],
    config: "artwork-v1",
    action: async (inputs) => {
      const rawPath = inputs[avatarName]!;
      await ffmpeg.processChannelArtwork(rawPath, artworkPath);
      return JSON.stringify({
        uploads: [
          {
            localPath: artworkPath,
            r2Key: "artwork.jpg",
            cacheControl: "max-age=86400",
          },
        ],
      } satisfies ArtworkOutput);
    },
  });

  return jsonRef<ArtworkOutput>(artworkName);
}
