import { describe, expect, test } from "bun:test";

import { parseVideoList } from "./ytdlp";

describe("parseVideoList", () => {
  test("parses standard yt-dlp output", () => {
    const output = "abc123|20240315|My Video Title\nxyz789|20240310|Another Video\n";
    expect(parseVideoList(output)).toEqual([
      { id: "abc123", uploadDate: "20240315", title: "My Video Title" },
      { id: "xyz789", uploadDate: "20240310", title: "Another Video" },
    ]);
  });

  test("title containing pipe characters is preserved", () => {
    const output = "vid001|20240101|This | That | The Other\n";
    expect(parseVideoList(output)).toEqual([
      { id: "vid001", uploadDate: "20240101", title: "This | That | The Other" },
    ]);
  });

  test("throws on malformed line with fewer than 3 fields", () => {
    expect(() => parseVideoList("only-one-field\n")).toThrow("Malformed yt-dlp output");
    expect(() => parseVideoList("two|fields\n")).toThrow("Malformed yt-dlp output");
  });

  test("skips blank lines and trims trailing whitespace", () => {
    const output = "\nabc|20240101|Title\n\n\nxyz|20240202|Other\n\n";
    expect(parseVideoList(output)).toEqual([
      { id: "abc", uploadDate: "20240101", title: "Title" },
      { id: "xyz", uploadDate: "20240202", title: "Other" },
    ]);
  });
});
