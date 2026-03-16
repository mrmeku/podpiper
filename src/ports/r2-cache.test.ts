import { describe, expect, test } from "bun:test";
import type { CacheEntry } from "@podpiper/dagraph";
import { createMemoryFs } from "./memory-fs";
import { createMemoryObjectStore } from "./memory-object-store";
import { createR2Cache } from "./r2-cache";

const BUCKET = "test-bucket";
const CAS_BASE = "/cas";

describe("R2Cache", () => {
  test("round-trip: put stores relative paths in R2, get restores absolute paths locally", async () => {
    const storage = createMemoryObjectStore();
    const writerFs = createMemoryFs();
    const writerCache = createR2Cache({ storage, fs: writerFs, bucket: BUCKET, casBaseDir: CAS_BASE });

    await writerFs.writeText("/cas/abc123/audio.mp3", "mp3-data");
    await writerFs.writeText("/cas/abc123/info.json", '{"title":"test"}');
    await writerCache.put("abc123", {
      outputs: { audio: "/cas/abc123/audio.mp3", info: "/cas/abc123/info.json" },
      contentHash: "hash-abc",
    });

    // Verify R2 manifest has relative paths
    const manifestRaw = await storage.getFile(BUCKET, "cas/abc123/manifest.json");
    const manifest = JSON.parse(new TextDecoder().decode(manifestRaw!)) as CacheEntry;
    expect(manifest).toEqual({
      outputs: { audio: "audio.mp3", info: "info.json" },
      contentHash: "hash-abc",
    });

    // Get from fresh FS — files should be downloaded and paths made absolute
    const readerFs = createMemoryFs();
    const readerCache = createR2Cache({ storage, fs: readerFs, bucket: BUCKET, casBaseDir: CAS_BASE });
    const restored = await readerCache.get("abc123");

    expect(restored).toEqual({
      outputs: { audio: "/cas/abc123/audio.mp3", info: "/cas/abc123/info.json" },
      contentHash: "hash-abc",
    });
    expect(await readerFs.readText("/cas/abc123/audio.mp3")).toBe("mp3-data");
    expect(await readerFs.readText("/cas/abc123/info.json")).toBe('{"title":"test"}');
  });

  test("get returns undefined when manifest does not exist in R2", async () => {
    const storage = createMemoryObjectStore();
    const cache = createR2Cache({ storage, fs: createMemoryFs(), bucket: BUCKET, casBaseDir: CAS_BASE });
    expect(await cache.get("nonexistent")).toBeUndefined();
  });

  test("get returns undefined when a referenced file is missing from R2", async () => {
    const storage = createMemoryObjectStore();
    // Manually upload only the manifest, not the file it references
    const manifest: CacheEntry = { outputs: "missing-file.mp3", contentHash: "h" };
    await storage.uploadFile(
      new TextEncoder().encode(JSON.stringify(manifest)),
      "cas/abc123/manifest.json",
      BUCKET,
    );

    const cache = createR2Cache({ storage, fs: createMemoryFs(), bucket: BUCKET, casBaseDir: CAS_BASE });
    expect(await cache.get("abc123")).toBeUndefined();
  });

  test("handles string output (single file path)", async () => {
    const storage = createMemoryObjectStore();
    const fs = createMemoryFs();
    const cache = createR2Cache({ storage, fs, bucket: BUCKET, casBaseDir: CAS_BASE });

    await fs.writeText("/cas/key1/thumb.jpg", "jpg-data");
    await cache.put("key1", { outputs: "/cas/key1/thumb.jpg", contentHash: "h1" });

    const readerFs = createMemoryFs();
    const reader = createR2Cache({ storage, fs: readerFs, bucket: BUCKET, casBaseDir: CAS_BASE });
    const restored = await reader.get("key1");

    expect(restored).toEqual({ outputs: "/cas/key1/thumb.jpg", contentHash: "h1" });
    expect(await readerFs.readText("/cas/key1/thumb.jpg")).toBe("jpg-data");
  });

  test("handles array output (multiple file paths)", async () => {
    const storage = createMemoryObjectStore();
    const fs = createMemoryFs();
    const cache = createR2Cache({ storage, fs, bucket: BUCKET, casBaseDir: CAS_BASE });

    await fs.writeText("/cas/key2/a.txt", "aaa");
    await fs.writeText("/cas/key2/b.txt", "bbb");
    await cache.put("key2", { outputs: ["/cas/key2/a.txt", "/cas/key2/b.txt"], contentHash: "h2" });

    const readerFs = createMemoryFs();
    const reader = createR2Cache({ storage, fs: readerFs, bucket: BUCKET, casBaseDir: CAS_BASE });
    const restored = await reader.get("key2");

    expect(restored).toEqual({ outputs: ["/cas/key2/a.txt", "/cas/key2/b.txt"], contentHash: "h2" });
  });
});
