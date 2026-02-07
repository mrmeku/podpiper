import type { YouTubeDownloader } from "@/ports/types";
import type { VideoInfo } from "@/types";

export async function discoverVideos(
  channelUrl: string,
  ytdlp: YouTubeDownloader,
): Promise<VideoInfo[]> {
  return ytdlp.fetchVideoList(channelUrl);
}
