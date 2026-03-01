import { describe, expect, test } from "bun:test";

import { TEST_CONFIG } from "@/pipeline/test-fixtures";
import type { Episode } from "@/types";

import { buildFeedXml } from "./generate";
import { mergeEpisodes, parseExistingFeed } from "./parse";

const BASE_URL = TEST_CONFIG.storage.publicUrl;

const EP_WITH_CHAPTERS: Episode = {
  id: "vid_aaa",
  title: "Episode With Chapters",
  description: "Has chapters",
  uploadDate: "20240315",
  duration: 1800,
  filename: "vid_aaa/audio.mp3",
  fileSize: 1000,
  thumbnail: "vid_aaa/thumbnail.jpg",
  chapters: [
    { startTime: 0, endTime: 600, title: "Intro" },
    { startTime: 600, endTime: 1800, title: "Main" },
  ],
  transcript: "vid_aaa/transcript.srt",
};

const EP_WITHOUT_CHAPTERS: Episode = {
  id: "vid_bbb",
  title: "Episode Without Chapters",
  description: "No chapters",
  uploadDate: "20240310",
  duration: 2400,
  filename: "vid_bbb/audio.mp3",
  fileSize: 2000,
  thumbnail: "vid_bbb/thumbnail.jpg",
  chapters: [],
  transcript: null,
};

describe("feed round-trip preserves chapters", () => {
  test("parseExistingFeed retains chapters flag from podcast:chapters element", () => {
    const xml = buildFeedXml(TEST_CONFIG, [EP_WITH_CHAPTERS, EP_WITHOUT_CHAPTERS]);
    const parsed = parseExistingFeed(BASE_URL, xml);
    const byId = Object.fromEntries(parsed.map((ep) => [ep.id, ep]));
    expect(byId.vid_aaa!.chapters.length).toBeGreaterThan(0);
    expect(byId.vid_bbb!.chapters).toEqual([]);
  });

  test("merge then rebuild preserves podcast:chapters in XML", () => {
    const feedXml = buildFeedXml(TEST_CONFIG, [EP_WITH_CHAPTERS, EP_WITHOUT_CHAPTERS]);
    const existing = parseExistingFeed(BASE_URL, feedXml);
    const merged = mergeEpisodes(existing, []);
    const rebuiltXml = buildFeedXml(TEST_CONFIG, merged);
    expect(rebuiltXml).toContain("podcast:chapters");
    expect(rebuiltXml).toContain("vid_aaa/chapters.json");
  });
});
