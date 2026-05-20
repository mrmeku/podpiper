import { describe, expect, test } from "bun:test";

import { createMemoryFs } from "@/ports/memory-fs";
import { createMockPorts } from "@/ports/mock";
import { jsonPath } from "@/typed-path";
import type { YtDlpInfo } from "@/types";

import { NodeKind } from "./define-action";
import { DURATION_TOLERANCE_SECONDS, download, validateDownloadDuration } from "./download";

async function captureError(fn: () => Promise<unknown>): Promise<Error | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

const VIDEO_ID = "vid_test";
const OUTPUT_DIR = "/cas/download_test";

async function setupFs(opts: { duration?: number | undefined; actualDuration: number }) {
  const fs = createMemoryFs();
  const info: YtDlpInfo = {
    id: VIDEO_ID,
    title: "Test Video",
    upload_date: "20240315",
    ...(opts.duration !== undefined && { duration: opts.duration }),
  };
  const audioPath = `${OUTPUT_DIR}/audio.mp3`;
  const infoPath = `${OUTPUT_DIR}/audio.info.json`;
  await fs.writeText(audioPath, "fake-audio-bytes");
  await fs.writeText(infoPath, JSON.stringify(info));
  const ports = createMockPorts(fs, {
    ffmpeg: { probeDuration: async () => opts.actualDuration } as never,
  });
  return { fs, ports, audioPath, infoPath: jsonPath<YtDlpInfo>(infoPath) };
}

describe("validateDownloadDuration", () => {
  test("passes when ffprobe duration matches info.json exactly", async () => {
    const { ports, audioPath, infoPath } = await setupFs({
      duration: 1800,
      actualDuration: 1800,
    });
    await validateDownloadDuration(ports, audioPath, infoPath);
  });

  test("passes when delta is within tolerance", async () => {
    const { ports, audioPath, infoPath } = await setupFs({
      duration: 1800,
      actualDuration: 1800 + DURATION_TOLERANCE_SECONDS,
    });
    await validateDownloadDuration(ports, audioPath, infoPath);
  });

  test("throws when actual duration is shorter than tolerance allows (truncation)", async () => {
    const { ports, audioPath, infoPath } = await setupFs({
      duration: 1800,
      actualDuration: 900,
    });
    const err = await captureError(() => validateDownloadDuration(ports, audioPath, infoPath));
    expect(err?.message).toMatch(
      /duration mismatch.*info\.json=1800s.*ffprobe=900s.*delta=900\.00s/,
    );
  });

  test("throws when delta is just outside tolerance", async () => {
    const { ports, audioPath, infoPath } = await setupFs({
      duration: 1800,
      actualDuration: 1800 - (DURATION_TOLERANCE_SECONDS + 0.01),
    });
    const err = await captureError(() => validateDownloadDuration(ports, audioPath, infoPath));
    expect(err?.message).toMatch(/duration mismatch/);
  });

  test("skips validation when info.json has no duration field", async () => {
    const { ports, audioPath, infoPath } = await setupFs({
      duration: undefined,
      actualDuration: 9999,
    });
    await validateDownloadDuration(ports, audioPath, infoPath);
  });
});

describe("download action", () => {
  test("returns expected output paths when validation passes", async () => {
    const { ports } = await setupFs({ duration: 1800, actualDuration: 1801 });
    const ytdlpCalls: Array<{ outputDir: string; videoId: string }> = [];
    ports.ytdlp.downloadAudio = async (outputDir, videoId) => {
      ytdlpCalls.push({ outputDir, videoId });
    };
    const action = download.createAction(ports);
    const result = await action({ kind: NodeKind.Download, videoId: VIDEO_ID }, {}, OUTPUT_DIR);
    expect(result).toEqual({
      audio: `${OUTPUT_DIR}/audio.mp3`,
      info: jsonPath<YtDlpInfo>(`${OUTPUT_DIR}/audio.info.json`),
      thumb: `${OUTPUT_DIR}/audio.jpg`,
    });
    expect(ytdlpCalls).toEqual([{ outputDir: OUTPUT_DIR, videoId: VIDEO_ID }]);
  });

  test("rejects when ffprobe reports a duration outside tolerance", async () => {
    const { ports } = await setupFs({ duration: 1800, actualDuration: 600 });
    ports.ytdlp.downloadAudio = async () => {};
    const action = download.createAction(ports);
    const err = await captureError(() =>
      action({ kind: NodeKind.Download, videoId: VIDEO_ID }, {}, OUTPUT_DIR),
    );
    expect(err?.message).toMatch(/duration mismatch/);
  });
});
