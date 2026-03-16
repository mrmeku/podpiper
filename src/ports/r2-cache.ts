import { collectPaths, type Cache, type CacheEntry, type Outputs } from "@podpiper/dagraph";
import type { FileSystem, ObjectStore } from "@/ports/types";

interface R2CacheOpts {
  storage: ObjectStore;
  fs: FileSystem;
  bucket: string;
  casBaseDir: string;
}

export function rewritePaths(outputs: Outputs, fn: (p: string) => string): Outputs {
  if (typeof outputs === "string") return fn(outputs);
  if (Array.isArray(outputs)) return outputs.map(fn);
  const result: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(outputs)) {
    result[k] = Array.isArray(v) ? v.map(fn) : fn(v);
  }
  return result;
}

export function createR2Cache(opts: R2CacheOpts): Cache {
  const { storage, fs, bucket, casBaseDir } = opts;
  const R2_PREFIX = "cas";

  const toRelative = (key: string) => {
    const prefix = `${casBaseDir}/${key}/`;
    return (p: string) => (p.startsWith(prefix) ? p.slice(prefix.length) : p);
  };
  const toAbsolute = (key: string) => (p: string) => `${casBaseDir}/${key}/${p}`;

  return {
    async get(key: string): Promise<CacheEntry | undefined> {
      try {
        const manifestData = await storage.getFile(bucket, `${R2_PREFIX}/${key}/manifest.json`);
        if (!manifestData) return undefined;

        const manifest = JSON.parse(new TextDecoder().decode(manifestData)) as CacheEntry;
        const localDir = `${casBaseDir}/${key}`;
        await fs.ensureDir(localDir);

        for (const relPath of collectPaths(manifest.outputs)) {
          const data = await storage.getFile(bucket, `${R2_PREFIX}/${key}/${relPath}`);
          if (!data) return undefined;
          await fs.writeBinary(`${localDir}/${relPath}`, data);
        }

        return {
          outputs: rewritePaths(manifest.outputs, toAbsolute(key)),
          contentHash: manifest.contentHash,
        };
      } catch {
        return undefined;
      }
    },

    async put(key: string, entry: CacheEntry): Promise<void> {
      const relOutputs = rewritePaths(entry.outputs, toRelative(key));

      for (const absPath of collectPaths(entry.outputs)) {
        const relPath = toRelative(key)(absPath);
        const data = await fs.readBinary(absPath);
        await storage.uploadFile(data, `${R2_PREFIX}/${key}/${relPath}`, bucket);
      }

      const manifestData = new TextEncoder().encode(JSON.stringify({ outputs: relOutputs, contentHash: entry.contentHash }, null, 2));
      await storage.uploadFile(manifestData, `${R2_PREFIX}/${key}/manifest.json`, bucket);
    },
  };
}
