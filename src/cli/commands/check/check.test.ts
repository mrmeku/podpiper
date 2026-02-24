import { describe, expect, test } from "bun:test";

import { buildFeedXml } from "@/pipeline/rss/generate";
import type { ObjectStore } from "@/ports/types";
import type { Config, Episode, VideoInfo } from "@/types";

import { checkMissing } from "./check";

const TEST_CONFIG: Config = {
  channelUrl: "https://www.youtube.com/@testchannel",
  outputDir: "/test/output",
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

function makeEpisode(id: string): Episode {
  return {
    id,
    title: `Episode ${id}`,
    description: "desc",
    uploadDate: "20240101",
    duration: 600,
    filename: `videos/${id}/audio.mp3`,
    fileSize: 1000,
    thumbnail: "",
    chapters: [],
    transcript: null,
  };
}

function mockStorage(feedXml: string | null): ObjectStore {
  return {
    uploadFile: async () => {},
    getFile: async () => (feedXml ? new TextEncoder().encode(feedXml) : null),
    listFiles: async () => new Set<string>(),
  };
}

const VIDEOS: VideoInfo[] = [
  { id: "vid_aaa", uploadDate: "20240315", title: "Video AAA" },
  { id: "vid_bbb", uploadDate: "20240310", title: "Video BBB" },
  { id: "vid_ccc", uploadDate: "20240305", title: "Video CCC" },
  { id: "vid_ddd", uploadDate: "20240301", title: "Video DDD" },
];

describe("checkMissing", () => {
  test("all videos missing when no feed exists", async () => {
    const missing = await checkMissing(VIDEOS, TEST_CONFIG, mockStorage(null));
    expect(missing).toEqual(VIDEOS);
  });

  test("returns interleaved missing when 1st and 3rd are in feed", async () => {
    const feedXml = buildFeedXml(TEST_CONFIG, [makeEpisode("vid_aaa"), makeEpisode("vid_ccc")]);
    const missing = await checkMissing(VIDEOS, TEST_CONFIG, mockStorage(feedXml));
    expect(missing).toEqual([VIDEOS[1]!, VIDEOS[3]!]);
  });

  test("returns empty when all videos are in feed", async () => {
    const feedXml = buildFeedXml(
      TEST_CONFIG,
      VIDEOS.map((v) => makeEpisode(v.id)),
    );
    const missing = await checkMissing(VIDEOS, TEST_CONFIG, mockStorage(feedXml));
    expect(missing).toEqual([]);
  });
});
