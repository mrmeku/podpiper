import { describe, expect, test } from "bun:test";
import type { CacheEntry } from "@podpiper/dagraph";
import { createMemoryFs } from "@/ports/memory-fs";
import { createMemoryObjectStore } from "@/ports/memory-object-store";
import { backfill, type BackfillOpts } from "./backfill";

const BUCKET = "test-bucket";
const CAS = "/data/cas";

function setup(files: Record<string, string | Uint8Array> = {}) {
  const fs = createMemoryFs(files);
  const storage = createMemoryObjectStore();
  const opts = (overrides?: Partial<BackfillOpts>): BackfillOpts => ({
    casBaseDir: CAS,
    bucket: BUCKET,
    fs,
    storage,
    parallel: 4,
    ...overrides,
  });
  const getManifest = async (actionKey: string): Promise<CacheEntry | null> => {
    const data = await storage.getFile(BUCKET, `cas/${actionKey}/manifest.json`);
    if (!data) return null;
    return JSON.parse(new TextDecoder().decode(data)) as CacheEntry;
  };
  const getFile = async (key: string): Promise<string | null> => {
    const data = await storage.getFile(BUCKET, key);
    if (!data) return null;
    return new TextDecoder().decode(data);
  };
  return { fs, storage, opts, getManifest, getFile };
}

function manifest(outputs: CacheEntry["outputs"], contentHash: string): string {
  return JSON.stringify({ outputs, contentHash } satisfies CacheEntry);
}

describe("backfill", () => {
  test("uploads new entries with rewritten relative paths, skips entries already on R2", async () => {
    const { storage, opts, getManifest, getFile } = setup({
      // "new-key" — not on R2, should be uploaded
      [`${CAS}/new-key/manifest.json`]: manifest(
        { audio: `${CAS}/new-key/audio.mp3`, info: `${CAS}/new-key/info.json` },
        "hash-new",
      ),
      [`${CAS}/new-key/audio.mp3`]: "mp3-bytes",
      [`${CAS}/new-key/info.json`]: '{"title":"test"}',
      // "existing-key" — will be pre-seeded on R2, should be skipped
      [`${CAS}/existing-key/manifest.json`]: manifest(
        { audio: `${CAS}/existing-key/audio.mp3` },
        "hash-existing",
      ),
      [`${CAS}/existing-key/audio.mp3`]: "existing-mp3",
    });

    // Pre-seed R2 with existing-key's manifest
    await storage.uploadFile(
      new TextEncoder().encode("already-there"),
      "cas/existing-key/manifest.json",
      BUCKET,
    );

    const result = await backfill(opts());

    expect(result).toEqual({ uploaded: 1, skipped: 1, failed: 0 });

    // Uploaded manifest should have relative paths, not absolute
    expect(await getManifest("new-key")).toEqual({
      outputs: { audio: "audio.mp3", info: "info.json" },
      contentHash: "hash-new",
    });
    expect(await getFile("cas/new-key/audio.mp3")).toBe("mp3-bytes");
    expect(await getFile("cas/new-key/info.json")).toBe('{"title":"test"}');

    // existing-key's manifest on R2 should be untouched
    expect(await getFile("cas/existing-key/manifest.json")).toBe("already-there");
  });

  test("upload failure in one entry does not block others", async () => {
    const { storage, opts } = setup({
      [`${CAS}/good/manifest.json`]: manifest(`${CAS}/good/out.txt`, "hash-good"),
      [`${CAS}/good/out.txt`]: "good-data",
      [`${CAS}/bad/manifest.json`]: manifest(`${CAS}/bad/out.txt`, "hash-bad"),
      [`${CAS}/bad/out.txt`]: "bad-data",
    });

    const originalUpload = storage.uploadFile.bind(storage);
    storage.uploadFile = async (data, key, bucket, cacheControl?) => {
      if (key.startsWith("cas/bad/")) throw new Error("simulated R2 failure");
      return originalUpload(data, key, bucket, cacheControl);
    };

    const result = await backfill(opts({ parallel: 1 }));

    expect(result).toEqual({ uploaded: 1, skipped: 0, failed: 1 });
    // Good entry made it to R2
    const goodManifest = await storage.getFile(BUCKET, "cas/good/manifest.json");
    expect(goodManifest).not.toBeNull();
    // Bad entry did not
    const badManifest = await storage.getFile(BUCKET, "cas/bad/manifest.json");
    expect(badManifest).toBeNull();
  });

  test("dry run counts entries without uploading", async () => {
    const { storage, opts } = setup({
      [`${CAS}/key1/manifest.json`]: manifest(`${CAS}/key1/out.txt`, "h1"),
      [`${CAS}/key1/out.txt`]: "data1",
    });

    const result = await backfill(opts({ dryRun: true }));

    expect(result).toEqual({ uploaded: 1, skipped: 0, failed: 0 });
    expect(storage.size()).toBe(0);
  });
});
