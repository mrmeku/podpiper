import type { Command } from "commander";

import { getConfig } from "@/config";
import { parseExistingFeed } from "@/pipeline/rss/parse";
import { createRealPorts } from "@/ports/real";
import type { ObjectStore } from "@/ports/types";
import type { Config, VideoInfo } from "@/types";

export function registerCheck(program: Command) {
  program
    .command("check")
    .description("Show videos not in feed (dry run)")
    .argument("<channel>", "Channel name")
    .action(async (channel: string) => {
      const config = getConfig(channel);
      const ports = createRealPorts();

      const videos = await ports.ytdlp.fetchVideoList(config.channelUrl);
      const missing = await checkMissing(videos, config, ports.storage);
      console.log(`${missing.length} videos not in feed:`);
      for (const v of missing) {
        console.log(`  ${v.uploadDate} ${v.id} ${v.title}`);
      }
    });
}

export async function checkMissing(
  videos: VideoInfo[],
  config: Config,
  storage: ObjectStore,
): Promise<VideoInfo[]> {
  const feedData = await storage.getFile(config.storage.bucket, "feed.xml");
  const existing = new Set<string>();
  if (feedData) {
    const episodes = parseExistingFeed(config.storage.publicUrl, new TextDecoder().decode(feedData));
    for (const ep of episodes) existing.add(ep.id);
  }
  return videos.filter((v) => !existing.has(v.id));
}
