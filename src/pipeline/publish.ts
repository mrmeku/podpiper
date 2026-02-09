import { buildFeedXml } from "@/pipeline/rss/generate";
import { mergeEpisodes, parseExistingFeed } from "@/pipeline/rss/parse";
import type { FileSystem, ObjectStore } from "@/ports/types";
import type { Config } from "@/types";

import type { SyncResult } from "./execute";

export async function publish(
  result: SyncResult,
  config: Config,
  fs: FileSystem,
  storage: ObjectStore,
): Promise<void> {
  for (const u of result.uploads) {
    await storage.uploadFile(u.localPath, u.r2Key, config.r2.bucket, u.cacheControl);
  }
  const feedData = await storage.getFile(config.r2.bucket, "feed.xml");
  const existing = feedData
    ? parseExistingFeed(config.r2.publicUrl, new TextDecoder().decode(feedData))
    : [];
  const allEpisodes = mergeEpisodes(existing, result.episodes);
  const feedXml = buildFeedXml(config, allEpisodes);
  const feedPath = `${config.outputDir}/feed.xml`;
  await fs.writeText(feedPath, feedXml);
  await storage.uploadFile(feedPath, "feed.xml", config.r2.bucket, "max-age=300");
}
