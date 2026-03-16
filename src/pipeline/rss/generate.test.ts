import { describe, expect, test } from "bun:test";
import { XMLParser } from "fast-xml-parser";

import { TEST_CONFIG } from "@/pipeline/test-fixtures";
import type { Episode } from "@/types";

import { buildFeedXml } from "./generate";

const EPISODE: Episode = {
  id: "vid_001",
  title: "Test Episode",
  description: "A <bold> description & more",
  uploadDate: "20240315",
  duration: 1800,
  filename: "vid_001/audio.mp3",
  fileSize: 1024,
  summary: null,
  thumbnail: "vid_001/thumbnail.jpg",
  chapters: [],
  chaptersGenerated: false,
  transcript: null,
};

const EPISODE_WITH_ALL: Episode = {
  ...EPISODE,
  description: "Video description",
  summary: "Summary line one\nstill part of summary",
  chaptersGenerated: false,
  chapters: [
    { startTime: 0, endTime: 120, title: "Intro" },
    { startTime: 120, endTime: 3661, title: "Main Topic" },
    { startTime: 3661, endTime: 7200, title: "Long Chapter" },
  ],
};

const EPISODE_WITH_GENERATED_CHAPTERS: Episode = {
  ...EPISODE_WITH_ALL,
  chaptersGenerated: true,
};

describe("buildFeedXml", () => {
  test("description-only episode has no separators", () => {
    const xml = buildFeedXml(TEST_CONFIG, [EPISODE]);
    const parsed = new XMLParser().parse(xml);
    const item = parsed.rss.channel.item;
    expect(item.description).toBe(EPISODE.description);
    expect(item["content:encoded"]).toBe(`<p>${EPISODE.description}</p>`);
  });

  test("youtube chapters use — Chapters — separator", () => {
    const xml = buildFeedXml(TEST_CONFIG, [EPISODE_WITH_ALL]);
    const parsed = new XMLParser().parse(xml);
    const item = parsed.rss.channel.item;
    expect(item.description).toBe(
      "Video description\n\n" +
        "— Chapters —\n" +
        "0:00 — Intro\n2:00 — Main Topic\n1:01:01 — Long Chapter\n\n" +
        "— Generated Summary —\n" +
        "Summary line one\nstill part of summary",
    );
  });

  test("generated chapters use — Generated Chapters — separator", () => {
    const xml = buildFeedXml(TEST_CONFIG, [EPISODE_WITH_GENERATED_CHAPTERS]);
    const parsed = new XMLParser().parse(xml);
    const item = parsed.rss.channel.item;
    expect(item.description).toBe(
      "Video description\n\n" +
        "— Generated Chapters —\n" +
        "0:00 — Intro\n2:00 — Main Topic\n1:01:01 — Long Chapter\n\n" +
        "— Generated Summary —\n" +
        "Summary line one\nstill part of summary",
    );
  });
});
