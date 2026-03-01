import { describe, expect, test } from "bun:test";

import { createMemoryFs } from "@/ports/memory-fs";
import { createMockPorts } from "@/ports/mock";
import { jsonPath } from "@/typed-path";
import type { Chapter, Episode, UploadEntry, YtDlpInfo } from "@/types";

import { NodeKind } from "./define-action";
import { rssEntry } from "./rss-entry";

const VIDEO_ID = "vid_test";
const OUTPUT_DIR = "/cas/rss_entry_test";

const TEST_INFO: YtDlpInfo = {
  id: VIDEO_ID,
  title: "Test Video",
  description: "A test description.",
  upload_date: "20240315",
  duration: 1800,
};

const TEST_CHAPTERS: Chapter[] = [
  { startTime: 0, endTime: 600, title: "Intro" },
  { startTime: 600, endTime: 1800, title: "Main" },
];

async function setupFs(opts: {
  info?: YtDlpInfo;
  chapters?: Chapter[];
  hasSrt?: boolean;
  summary?: string;
  embedChaptersAudio?: string;
}) {
  const fs = createMemoryFs();
  const info = opts.info ?? TEST_INFO;
  const chapters = opts.chapters ?? [];

  const downloadDir = "/cas/download";
  await fs.writeText(`${downloadDir}/audio.mp3`, "fake-audio");
  await fs.writeText(`${downloadDir}/audio.info.json`, JSON.stringify(info));

  const transcribeDir = "/cas/transcribe";
  if (opts.hasSrt !== false) {
    await fs.writeText(`${transcribeDir}/audio.srt`, "1\n00:00:00 --> 00:05:00\nHello\n");
  }

  await fs.writeText("/cas/chapters/chapters.json", JSON.stringify(chapters));
  await fs.writeText("/cas/thumbnail/thumbnail.jpg", "fake-thumb");

  if (opts.embedChaptersAudio) {
    await fs.writeText(opts.embedChaptersAudio, "fake-embedded-audio");
  }
  if (opts.summary) {
    await fs.writeText("/cas/summary/summary.txt", opts.summary);
  }

  const inputs = {
    download: {
      audio: `${downloadDir}/audio.mp3`,
      info: jsonPath<YtDlpInfo>(`${downloadDir}/audio.info.json`),
      thumb: `${downloadDir}/audio.jpg`,
    },
    transcribe: {
      srt: `${transcribeDir}/audio.srt`,
      json: jsonPath<any>(`${transcribeDir}/audio.json`),
    },
    thumbnail: "/cas/thumbnail/thumbnail.jpg",
    chapters: jsonPath<Chapter[]>("/cas/chapters/chapters.json"),
    ...(opts.embedChaptersAudio && { embedChapters: opts.embedChaptersAudio }),
    ...(opts.summary && { summary: "/cas/summary/summary.txt" }),
  };

  const ports = createMockPorts(fs);
  return { fs, ports, inputs };
}

const PARAMS = { kind: NodeKind.RssEntry as typeof NodeKind.RssEntry, videoId: VIDEO_ID, deps: {} as any };

describe("rssEntry action", () => {
  test("with chapters, SRT, and summary produces full episode and uploads", async () => {
    const { ports, fs, inputs } = await setupFs({
      chapters: TEST_CHAPTERS,
      hasSrt: true,
      summary: "A great summary.",
      embedChaptersAudio: "/cas/embed/audio.mp3",
    });
    const action = rssEntry.createAction(ports);
    const result = await action(PARAMS, inputs, OUTPUT_DIR);
    const episode: Episode = JSON.parse(await fs.readText(result.episode));
    const uploads: UploadEntry[] = JSON.parse(await fs.readText(result.uploads));

    expect(episode).toEqual({
      id: VIDEO_ID,
      title: "Test Video",
      description: "A test description.\n\n— Generated Summary —\n\nA great summary.",
      uploadDate: "20240315",
      duration: 1800,
      filename: "vid_test/audio.mp3",
      fileSize: expect.any(Number),
      thumbnail: "vid_test/thumbnail.jpg",
      chapters: TEST_CHAPTERS,
      transcript: "vid_test/transcript.srt",
    });
    expect(uploads.map((u) => u.key).sort()).toEqual([
      "vid_test/audio.mp3",
      "vid_test/chapters.json",
      "vid_test/thumbnail.jpg",
      "vid_test/transcript.srt",
    ]);
  });

  test("without SRT omits transcript from episode and uploads", async () => {
    const { ports, fs, inputs } = await setupFs({ hasSrt: false });
    const action = rssEntry.createAction(ports);
    const result = await action(PARAMS, inputs, OUTPUT_DIR);
    const episode: Episode = JSON.parse(await fs.readText(result.episode));
    const uploads: UploadEntry[] = JSON.parse(await fs.readText(result.uploads));

    expect(episode.transcript).toBeNull();
    expect(uploads.map((u) => u.key).sort()).toEqual([
      "vid_test/audio.mp3",
      "vid_test/thumbnail.jpg",
    ]);
  });

  test("without chapters omits chapters.json from uploads", async () => {
    const { ports, fs, inputs } = await setupFs({ chapters: [] });
    const action = rssEntry.createAction(ports);
    const result = await action(PARAMS, inputs, OUTPUT_DIR);
    const uploads: UploadEntry[] = JSON.parse(await fs.readText(result.uploads));

    expect(uploads.find((u) => u.key.includes("chapters.json"))).toBeUndefined();
  });

  test("without summary uses raw description only", async () => {
    const { ports, fs, inputs } = await setupFs({});
    const action = rssEntry.createAction(ports);
    const result = await action(PARAMS, inputs, OUTPUT_DIR);
    const episode: Episode = JSON.parse(await fs.readText(result.episode));

    expect(episode.description).toBe("A test description.");
  });

  test("uses embedChapters audio path for fileSize and upload when present", async () => {
    const embedPath = "/cas/embed/audio.mp3";
    const { ports, fs, inputs } = await setupFs({ embedChaptersAudio: embedPath });
    const action = rssEntry.createAction(ports);
    const result = await action(PARAMS, inputs, OUTPUT_DIR);
    const uploads: UploadEntry[] = JSON.parse(await fs.readText(result.uploads));
    const audioUpload = uploads.find((u) => u.key === "vid_test/audio.mp3")!;

    expect(audioUpload.localPath).toBe(embedPath);
  });
});
