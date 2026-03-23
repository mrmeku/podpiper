import NodeID3 from "node-id3";

import { exec } from "@/ports/exec";
import type { Chapter } from "@/types";
import type { MediaProcessor } from "./types";

function buildId3ChapterTags(chapters: Chapter[]) {
  const toMs = (s: number) => Math.round(s * 1000);
  const chapterTags = chapters.map((ch, i) => ({
    elementID: `chap${i}`,
    startTimeMs: toMs(ch.startTime),
    endTimeMs: toMs(ch.endTime),
    tags: { title: ch.title },
  }));
  return {
    chapter: chapterTags,
    tableOfContents: [
      { elementID: "toc", isOrdered: true, elements: chapterTags.map((c) => c.elementID) },
    ],
  };
}

export function createRealFfmpeg(): MediaProcessor {
  return {
    squareThumbnail: async (input, output) => {
      await exec([
        "ffmpeg",
        "-y",
        "-i",
        input,
        "-vf",
        "pad=iw:iw:0:(oh-ih)/2:black,scale=1400:1400:flags=lanczos",
        "-q:v",
        "2",
        output,
      ]);
    },
    processChannelArtwork: async (rawPath, outputPath) => {
      await exec([
        "ffmpeg",
        "-y",
        "-i",
        rawPath,
        "-vf",
        "scale=1400:1400:flags=lanczos",
        "-q:v",
        "2",
        outputPath,
      ]);
    },
    embedChapters: async (audioPath, chapters, outputPath) => {
      const buf = Buffer.from(await Bun.file(audioPath).arrayBuffer());
      if (chapters.length === 0) {
        await Bun.write(outputPath, buf);
        return;
      }
      const tags = buildId3ChapterTags(chapters);
      const result = NodeID3.update(tags, buf);
      if (result instanceof Error) throw result;
      await Bun.write(outputPath, result);
    },
  };
}
