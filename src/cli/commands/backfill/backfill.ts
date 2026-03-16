import type { Command } from "commander";
import { getConfig } from "@/config";
import { createRealPorts } from "@/ports/real";
import { rewritePaths } from "@/ports/r2-cache";
import type { FileSystem, ObjectStore } from "@/ports/types";
import type { CacheEntry } from "@podpiper/dagraph";
import { collectPaths } from "@podpiper/dagraph";

export interface BackfillOpts {
  casBaseDir: string;
  bucket: string;
  fs: FileSystem;
  storage: ObjectStore;
  parallel: number;
  dryRun?: boolean;
}

export interface BackfillResult {
  uploaded: number;
  skipped: number;
  failed: number;
}

export async function backfill(opts: BackfillOpts): Promise<BackfillResult> {
  const { casBaseDir, bucket, fs, storage, parallel } = opts;

  let entries: string[];
  try {
    entries = await fs.readdir(casBaseDir);
  } catch {
    return { uploaded: 0, skipped: 0, failed: 0 };
  }

  let uploaded = 0;
  let skipped = 0;
  let failed = 0;

  const semaphore = { active: 0, queue: [] as (() => void)[] };
  const acquire = () =>
    new Promise<void>((resolve) => {
      if (semaphore.active < parallel) {
        semaphore.active++;
        resolve();
      } else {
        semaphore.queue.push(resolve);
      }
    });
  const release = () => {
    semaphore.active--;
    const next = semaphore.queue.shift();
    if (next) {
      semaphore.active++;
      next();
    }
  };

  const toRelative = (actionKey: string) => {
    const prefix = `${casBaseDir}/${actionKey}/`;
    return (p: string) => (p.startsWith(prefix) ? p.slice(prefix.length) : p);
  };

  const tasks = entries.map(async (actionKey) => {
    await acquire();
    try {
      const manifestPath = `${casBaseDir}/${actionKey}/manifest.json`;
      let raw: string;
      try {
        raw = await fs.readText(manifestPath);
      } catch {
        return;
      }

      const r2ManifestKey = `cas/${actionKey}/manifest.json`;
      const exists = await storage.fileExists(bucket, r2ManifestKey);
      if (exists) {
        skipped++;
        return;
      }

      const entry = JSON.parse(raw) as CacheEntry;
      const absolutePaths = collectPaths(entry.outputs);
      const relOutputs = rewritePaths(entry.outputs, toRelative(actionKey));

      if (opts.dryRun) {
        uploaded++;
        return;
      }

      for (const absPath of absolutePaths) {
        const relPath = toRelative(actionKey)(absPath);
        const data = await fs.readBinary(absPath);
        await storage.uploadFile(data, `cas/${actionKey}/${relPath}`, bucket);
      }

      const manifest: CacheEntry = { outputs: relOutputs, contentHash: entry.contentHash };
      const manifestData = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
      await storage.uploadFile(manifestData, r2ManifestKey, bucket);

      uploaded++;
    } catch (err) {
      failed++;
      console.error(`Failed: ${actionKey} — ${err}`);
    } finally {
      release();
    }
  });

  await Promise.all(tasks);
  return { uploaded, skipped, failed };
}

export function registerBackfill(program: Command) {
  program
    .command("backfill")
    .description("Upload local CAS cache to R2 remote")
    .argument("<channel>", "Channel name")
    .option("-p, --parallel <n>", "Upload concurrency", (v: string) => parseInt(v), 4)
    .option("-d, --dry-run", "Show what would be uploaded without uploading")
    .action(async (channel: string, opts: { parallel: number; dryRun?: boolean }) => {
      const config = getConfig(channel);
      const ports = createRealPorts();
      const casBaseDir = config.casBaseDir;
      const { bucket } = config.storage;

      const result = await backfill({
        casBaseDir,
        bucket,
        fs: ports.fs,
        storage: ports.storage,
        parallel: opts.parallel,
        dryRun: opts.dryRun ?? false,
      });

      console.log(`\nBackfill complete: ${result.uploaded} uploaded, ${result.skipped} skipped, ${result.failed} failed`);
    });
}
