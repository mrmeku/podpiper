import { describe, expect, test } from "bun:test";

import { createMemoryFs } from "@/ports/memory-fs";
import { createStubPorts } from "@/ports/stub";
import type { Config, Episode, UploadEntry } from "@/types";

import type { SyncResult } from "./execute";
import { publish } from "./publish";
import { parseExistingFeed } from "./rss/parse";

const TEST_CONFIG: Config = {
  channelUrl: "https://www.youtube.com/@test",
  outputDir: "/test/output",
  casBaseDir: "/test/output/cas",
  storage: { bucket: "test-bucket", publicUrl: "https://cdn.test.com" },
  podcast: {
    title: "Test Podcast",
    author: "Test Author",
    description: "A test podcast",
    category: "Technology",
    ownerEmail: "test@example.com",
    copyright: "Test Author",
  },
};

function makeEpisode(id: string, uploadDate: string): Episode {
  return {
    id,
    title: `Episode ${id}`,
    description: `Description for ${id}`,
    uploadDate,
    duration: 1800,
    filename: `${id}/audio.mp3`,
    fileSize: 1024,
    resolvedLinks: {},
    summary: null,
    thumbnail: `${id}/thumbnail.jpg`,
    chapters: [],
    chaptersGenerated: false,
    transcript: null,
  };
}

function makeSyncResult(episodes: Episode[], uploads: UploadEntry[]): SyncResult {
  return { episodes, uploads, results: [] };
}

describe("publish", () => {
  test("uploads files, fetches existing feed, merges episodes, and uploads feed.xml", async () => {
    const fs = createMemoryFs();
    const uploadedFiles: { key: string; cacheControl?: string }[] = [];
    const storage = {
      ...createStubPorts().storage,
      uploadFile: async (_data: Uint8Array, key: string, _bucket: string, cacheControl?: string) => {
        uploadedFiles.push({ key, ...(cacheControl && { cacheControl }) });
      },
      getFile: async () => null,
      fileExists: async () => false,
    };

    const ep1 = makeEpisode("ep1", "20240315");
    const ep2 = makeEpisode("ep2", "20240310");
    await fs.writeText("/local/ep1.mp3", "audio");
    await fs.writeText("/local/ep2.mp3", "audio");

    const sr = makeSyncResult([ep1, ep2], [
      { localPath: "/local/ep1.mp3", key: "ep1/audio.mp3" },
      { localPath: "/local/ep2.mp3", key: "ep2/audio.mp3" },
    ]);

    await publish(sr, TEST_CONFIG, fs, storage);

    expect(uploadedFiles.sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { key: "ep1/audio.mp3" },
      { key: "ep2/audio.mp3" },
      { key: "feed.xml", cacheControl: "max-age=300" },
    ]);

    const feedXml = await fs.readText("/test/output/feed.xml");
    const parsedEpisodes = parseExistingFeed("https://cdn.test.com", feedXml);
    expect(parsedEpisodes.map((e) => e.id).sort()).toEqual(["ep1", "ep2"]);
  });

  test("merges new episodes with existing feed from storage", async () => {
    const fs = createMemoryFs();

    const existingEp = makeEpisode("old_ep", "20240101");
    const existingSr = makeSyncResult([existingEp], []);
    const firstRunStorage = {
      ...createStubPorts().storage,
      uploadFile: async () => {},
      getFile: async () => null,
      fileExists: async () => false,
    };
    await publish(existingSr, TEST_CONFIG, fs, firstRunStorage);
    const firstFeed = await fs.readText("/test/output/feed.xml");

    const newEp = makeEpisode("new_ep", "20240315");
    const newSr = makeSyncResult([newEp], []);
    const secondRunStorage = {
      ...createStubPorts().storage,
      uploadFile: async () => {},
      getFile: async (_bucket: string, key: string) => {
        if (key === "feed.xml") return new TextEncoder().encode(firstFeed);
        return null;
      },
      fileExists: async () => false,
    };
    await publish(newSr, TEST_CONFIG, fs, secondRunStorage);

    const mergedFeed = await fs.readText("/test/output/feed.xml");
    const episodes = parseExistingFeed("https://cdn.test.com", mergedFeed);
    expect(episodes.map((e) => e.id)).toEqual(["new_ep", "old_ep"]);
  });

  test("new episodes overwrite existing episodes with same ID", async () => {
    const fs = createMemoryFs();

    const oldEp = makeEpisode("ep1", "20240315");
    oldEp.title = "Old Title";
    const oldSr = makeSyncResult([oldEp], []);
    const firstStorage = {
      ...createStubPorts().storage,
      uploadFile: async () => {},
      getFile: async () => null,
      fileExists: async () => false,
    };
    await publish(oldSr, TEST_CONFIG, fs, firstStorage);
    const firstFeed = await fs.readText("/test/output/feed.xml");

    const updatedEp = makeEpisode("ep1", "20240315");
    updatedEp.title = "New Title";
    const newSr = makeSyncResult([updatedEp], []);
    const secondStorage = {
      ...createStubPorts().storage,
      uploadFile: async () => {},
      getFile: async (_bucket: string, key: string) => {
        if (key === "feed.xml") return new TextEncoder().encode(firstFeed);
        return null;
      },
      fileExists: async () => false,
    };
    await publish(newSr, TEST_CONFIG, fs, secondStorage);

    const mergedFeed = await fs.readText("/test/output/feed.xml");
    const episodes = parseExistingFeed("https://cdn.test.com", mergedFeed);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.title).toBe("New Title");
  });

  test("skips uploading files that already exist on R2", async () => {
    const fs = createMemoryFs();
    const uploadedFiles: { key: string }[] = [];
    const existingKeys = new Set(["ep1/audio.mp3"]);
    const storage = {
      ...createStubPorts().storage,
      uploadFile: async (_data: Uint8Array, key: string) => {
        uploadedFiles.push({ key });
      },
      getFile: async () => null,
      fileExists: async (_bucket: string, key: string) => existingKeys.has(key),
    };

    const ep1 = makeEpisode("ep1", "20240315");
    const ep2 = makeEpisode("ep2", "20240310");
    await fs.writeText("/local/ep1.mp3", "audio");
    await fs.writeText("/local/ep2.mp3", "audio");

    const sr = makeSyncResult([ep1, ep2], [
      { localPath: "/local/ep1.mp3", key: "ep1/audio.mp3" },
      { localPath: "/local/ep2.mp3", key: "ep2/audio.mp3" },
    ]);

    await publish(sr, TEST_CONFIG, fs, storage);

    expect(uploadedFiles.sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { key: "ep2/audio.mp3" },
      { key: "feed.xml" },
    ]);
  });
});
