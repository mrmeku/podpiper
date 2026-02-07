import type { ObjectStore } from "@/ports/types";
import { parseExistingFeed } from "@/rss/parse";
import type { Config, VideoInfo } from "@/types";

export async function checkMissing(
  videos: VideoInfo[],
  config: Config,
  storage: ObjectStore,
): Promise<VideoInfo[]> {
  const feedData = await storage.getFile(config.r2.bucket, "feed.xml");
  const existing = new Set<string>();
  if (feedData) {
    const episodes = parseExistingFeed(config.r2.publicUrl, new TextDecoder().decode(feedData));
    for (const ep of episodes) existing.add(ep.id);
  }
  return videos.filter((v) => !existing.has(v.id));
}
