import { buildFeedXml } from "@/pipeline/rss/generate";
import { mergeEpisodes, parseExistingFeed } from "@/pipeline/rss/parse";
import type { FileSystem, ObjectStore } from "@/ports/types";
import type { Config, Episode, UploadEntry } from "@/types";

export interface PublishInput {
  uploads: UploadEntry[];
  episodes: Episode[];
}

async function uploadWithHash(
  storage: ObjectStore,
  fs: FileSystem,
  localPath: string,
  key: string,
  bucket: string,
  cacheControl?: string,
): Promise<void> {
  const hash = await fs.hashFile(localPath);
  const data = await fs.readBinary(localPath);
  await storage.uploadFile(data, key, bucket, {
    ...(cacheControl && { cacheControl }),
    metadata: { "content-sha256": hash },
  });
}

export async function publish(
  result: PublishInput,
  config: Config,
  fs: FileSystem,
  storage: ObjectStore,
): Promise<void> {
  const { bucket } = config.storage;
  for (const u of result.uploads) {
    await uploadWithHash(storage, fs, u.localPath, u.key, bucket, u.cacheControl);
  }
  const existingFeed = await storage.getFile(bucket, "feed.xml");
  const existing = existingFeed
    ? parseExistingFeed(config.storage.publicUrl, new TextDecoder().decode(existingFeed))
    : [];
  const allEpisodes = mergeEpisodes(existing, result.episodes);
  const feedXml = buildFeedXml(config, allEpisodes);
  await fs.writeText(`${config.outputDir}/feed.xml`, feedXml);
  await storage.uploadFile(new TextEncoder().encode(feedXml), "feed.xml", bucket, { cacheControl: "max-age=300" });
}

export async function reconcilePublish(
  result: PublishInput,
  config: Config,
  fs: FileSystem,
  storage: ObjectStore,
): Promise<void> {
  const { bucket } = config.storage;
  let skipped = 0;
  for (const u of result.uploads) {
    const localHash = await fs.hashFile(u.localPath);
    const head = await storage.headObject(bucket, u.key);
    if (head.exists && head.metadata?.["content-sha256"] === localHash) {
      skipped++;
      continue;
    }
    await uploadWithHash(storage, fs, u.localPath, u.key, bucket, u.cacheControl);
  }
  if (skipped > 0) console.log(`Reconciliation: skipped ${skipped} already-uploaded files`);
  const existingFeed = await storage.getFile(bucket, "feed.xml");
  const existing = existingFeed
    ? parseExistingFeed(config.storage.publicUrl, new TextDecoder().decode(existingFeed))
    : [];
  const allEpisodes = mergeEpisodes(existing, result.episodes);
  const feedXml = buildFeedXml(config, allEpisodes);
  await fs.writeText(`${config.outputDir}/feed.xml`, feedXml);
  await storage.uploadFile(new TextEncoder().encode(feedXml), "feed.xml", bucket, { cacheControl: "max-age=300" });
}
