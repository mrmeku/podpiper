import { describe, expect, test } from "bun:test";
import { XMLParser } from "fast-xml-parser";

import { TEST_CONFIG } from "@/pipeline/test-fixtures";
import type { Episode } from "@/types";

import { type DescriptionInput, buildDescriptionHtml, buildDescriptionText, buildFeedXml } from "./generate";

const EPISODE: Episode = {
  id: "vid_001",
  title: "Test Episode",
  description: "A <bold> description & more",
  uploadDate: "20240315",
  duration: 1800,
  filename: "vid_001/audio.mp3",
  fileSize: 1024,
  resolvedLinks: {},
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

const BASE_INPUT: DescriptionInput = {
  description: "",
  chapters: [],
  chaptersGenerated: false,
  summary: null,
  resolvedLinks: {},
};

describe("buildDescriptionText / buildDescriptionHtml", () => {
  test("YouTube URLs become titled links in HTML, stay raw in text", () => {
    const input: DescriptionInput = {
      ...BASE_INPUT,
      description:
        "Videos Referenced:\nhttps://www.youtube.com/watch?v=abc12345678\nhttps://youtu.be/xyz98765432\n\nVisit https://example.com/ for more",
      resolvedLinks: { abc12345678: "My Great Video", xyz98765432: "Another Video" },
    };
    expect(buildDescriptionText(input)).toBe(input.description);
    expect(buildDescriptionHtml(input)).toBe(
      '<p>Videos Referenced:<br><a href="https://www.youtube.com/watch?v=abc12345678">My Great Video</a><br><a href="https://youtu.be/xyz98765432">Another Video</a></p>\n' +
        '<p>Visit <a href="https://example.com/">https://example.com/</a> for more</p>',
    );
  });

  test("unresolved YouTube links fall back to URL text", () => {
    const input: DescriptionInput = {
      ...BASE_INPUT,
      description: "See https://www.youtube.com/watch?v=abc12345678",
    };
    expect(buildDescriptionHtml(input)).toBe(
      '<p>See <a href="https://www.youtube.com/watch?v=abc12345678">https://www.youtube.com/watch?v=abc12345678</a></p>',
    );
  });

  test("HTML entities are escaped", () => {
    const input: DescriptionInput = {
      ...BASE_INPUT,
      description: 'Use <b>bold</b> & "quotes"',
    };
    expect(buildDescriptionHtml(input)).toBe(
      "<p>Use &lt;b&gt;bold&lt;/b&gt; &amp; &quot;quotes&quot;</p>",
    );
  });

  test("chapters and summary render in both formats", () => {
    const input: DescriptionInput = {
      ...BASE_INPUT,
      description: "Intro text",
      chapters: [
        { startTime: 0, endTime: 120, title: "Start" },
        { startTime: 120, endTime: 600, title: "Middle" },
      ],
      chaptersGenerated: true,
      summary: "A summary.",
    };
    expect(buildDescriptionText(input)).toBe(
      "Intro text\n\n— Generated Chapters —\n0:00 — Start\n2:00 — Middle\n\n— Generated Summary —\nA summary.",
    );
    expect(buildDescriptionHtml(input)).toBe(
      "<p>Intro text</p>\n" +
        "<p>— Generated Chapters —<br>0:00 — Start<br>2:00 — Middle</p>\n" +
        "<p>— Generated Summary —<br>A summary.</p>",
    );
  });
});
