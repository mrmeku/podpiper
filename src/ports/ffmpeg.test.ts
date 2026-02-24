import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import NodeID3 from "node-id3";
import type { Chapter } from "@/types";
import { createRealFfmpeg } from "./ffmpeg";

const ffmpeg = createRealFfmpeg();

function tempPath(name: string) {
  return join(tmpdir(), `podpiper-test-${Date.now()}-${name}`);
}

describe("embedChapters", () => {
  test("embeds ID3 chapter tags with float start times", async () => {
    const inputPath = tempPath("input.mp3");
    const outputPath = tempPath("output.mp3");
    await Bun.write(inputPath, Buffer.alloc(256));

    const chapters: Chapter[] = [
      { startTime: 0, endTime: 62.123, title: "Introduction" },
      { startTime: 62.123, endTime: 180.5, title: "Main Topic" },
      { startTime: 180.5, endTime: 300, title: "Conclusion" },
    ];
    await ffmpeg.embedChapters(inputPath, chapters, outputPath);

    const tags = NodeID3.read(Buffer.from(await Bun.file(outputPath).arrayBuffer()));
    const strip = (ch: NonNullable<typeof tags.chapter>[number]) => ({
      elementID: ch.elementID,
      startTimeMs: ch.startTimeMs,
      endTimeMs: ch.endTimeMs,
      title: ch.tags?.title,
    });
    expect(tags.chapter!.map(strip)).toEqual([
      { elementID: "chap0", startTimeMs: 0, endTimeMs: 62123, title: "Introduction" },
      { elementID: "chap1", startTimeMs: 62123, endTimeMs: 180500, title: "Main Topic" },
      { elementID: "chap2", startTimeMs: 180500, endTimeMs: 300000, title: "Conclusion" },
    ]);
    expect(tags.tableOfContents?.[0]).toMatchObject({
      elementID: "toc",
      isOrdered: true,
      elements: ["chap0", "chap1", "chap2"],
    });
  });

  test("copies file unchanged when chapters are empty", async () => {
    const inputPath = tempPath("input.mp3");
    const outputPath = tempPath("output.mp3");
    const content = Buffer.from("fake audio data");
    await Bun.write(inputPath, content);

    await ffmpeg.embedChapters(inputPath, [], outputPath);

    const output = Buffer.from(await Bun.file(outputPath).arrayBuffer());
    expect(output).toEqual(content);
  });
});
