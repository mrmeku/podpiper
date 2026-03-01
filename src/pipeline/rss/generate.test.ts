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
  thumbnail: "vid_001/thumbnail.jpg",
  chapters: [],
  transcript: null,
};

describe("buildFeedXml", () => {
  test("content:encoded parses as raw HTML", () => {
    const xml = buildFeedXml(TEST_CONFIG, [EPISODE]);
    const parsed = new XMLParser().parse(xml);
    const item = parsed.rss.channel.item;
    expect(item["content:encoded"]).toBe(`<p>${EPISODE.description}</p>`);
  });
});
