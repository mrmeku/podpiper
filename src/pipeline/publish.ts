import { buildFeedXml } from "@/pipeline/rss/generate";
import { mergeEpisodes, parseExistingFeed } from "@/pipeline/rss/parse";
import type { FileSystem, ObjectStore } from "@/ports/types";
import type { Config, Episode, UploadEntry } from "@/types";

export interface PublishInput {
  uploads: UploadEntry[];
  episodes: Episode[];
}

export async function publish(
  result: PublishInput,
  config: Config,
  fs: FileSystem,
  storage: ObjectStore,
  now: () => Date,
  opts: { force?: boolean } = {},
): Promise<void> {
  for (const u of result.uploads) {
    if (!opts.force && (await storage.fileExists(config.storage.bucket, u.key))) continue;
    const data = await fs.readBinary(u.localPath);
    await storage.uploadFile(data, u.key, config.storage.bucket, u.cacheControl);
  }
  const existingFeed = await storage.getFile(config.storage.bucket, "feed.xml");
  const existing = existingFeed
    ? parseExistingFeed(config.storage.publicUrl, new TextDecoder().decode(existingFeed))
    : [];
  const allEpisodes = mergeEpisodes(existing, result.episodes);
  const feedXml = buildFeedXml(config, allEpisodes, now);
  await fs.writeText(`${config.outputDir}/feed.xml`, feedXml);
  await storage.uploadFile(new TextEncoder().encode(feedXml), "feed.xml", config.storage.bucket, "max-age=300");
}
