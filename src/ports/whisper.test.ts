import { describe, expect, test } from "bun:test";

import { formatSegmentsForLlm, parseChapterResponse } from "@/pipeline/actions/chapter-prompt";
import type { WhisperSegment } from "@/types";

const segments: WhisperSegment[] = [
  {
    timestamps: { from: "00:00:00,000", to: "00:00:10,000" },
    offsets: { from: 0, to: 10000 },
    text: " Welcome to the show.",
  },
  {
    timestamps: { from: "00:00:10,000", to: "00:00:25,000" },
    offsets: { from: 10000, to: 25000 },
    text: " Today we discuss AI.",
  },
  {
    timestamps: { from: "00:00:25,000", to: "00:01:00,000" },
    offsets: { from: 25000, to: 60000 },
    text: " Let's talk about transformers.",
  },
  {
    timestamps: { from: "00:01:00,000", to: "00:01:30,000" },
    offsets: { from: 60000, to: 90000 },
    text: " Thanks for watching.",
  },
];

describe("formatSegmentsForLlm", () => {
  test("produces compact numbered lines with trimmed text", () => {
    expect(formatSegmentsForLlm(segments)).toBe(
      "[0] Welcome to the show.\n[1] Today we discuss AI.\n[2] Let's talk about transformers.\n[3] Thanks for watching.",
    );
  });
});

describe("parseChapterResponse", () => {
  test("maps segment indices to startTime in seconds", () => {
    const response = `[{"segment": 0, "title": "Introduction"}, {"segment": 2, "title": "Transformers"}]`;
    expect(parseChapterResponse(response, segments)).toEqual([
      { startTime: 0, title: "Introduction" },
      { startTime: 25, title: "Transformers" },
    ]);
  });

  test("strips markdown fences", () => {
    const response = '```json\n[{"segment": 1, "title": "AI Discussion"}]\n```';
    expect(parseChapterResponse(response, segments)).toEqual([
      { startTime: 10, title: "AI Discussion" },
    ]);
  });

  test("filters out-of-bounds segment indices", () => {
    const response = `[{"segment": 0, "title": "OK"}, {"segment": 99, "title": "Bad"}, {"segment": -1, "title": "Negative"}]`;
    expect(parseChapterResponse(response, segments)).toEqual([{ startTime: 0, title: "OK" }]);
  });

  test("returns empty array for invalid JSON", () => {
    expect(parseChapterResponse("not json at all", segments)).toEqual([]);
  });

  test("returns empty array for non-array JSON", () => {
    expect(parseChapterResponse('{"segment": 0}', segments)).toEqual([]);
  });

  test("converts millisecond offsets to seconds correctly at minute boundaries", () => {
    const longSegments: WhisperSegment[] = [
      {
        timestamps: { from: "00:00:00,000", to: "00:00:30,000" },
        offsets: { from: 0, to: 30000 },
        text: " Intro",
      },
      {
        timestamps: { from: "00:05:00,000", to: "00:05:30,000" },
        offsets: { from: 300000, to: 330000 },
        text: " Five minutes in",
      },
      {
        timestamps: { from: "01:00:00,000", to: "01:00:30,000" },
        offsets: { from: 3600000, to: 3630000 },
        text: " One hour in",
      },
    ];
    const response = `[{"segment": 0, "title": "Start"}, {"segment": 1, "title": "Middle"}, {"segment": 2, "title": "Late"}]`;
    expect(parseChapterResponse(response, longSegments)).toEqual([
      { startTime: 0, title: "Start" },
      { startTime: 300, title: "Middle" },
      { startTime: 3600, title: "Late" },
    ]);
  });
});
