import { describe, expect, test } from "bun:test";

import { sync } from "@/pipeline/execute";
import { buildPipelineGraph } from "@/pipeline/graph-builder";
import { publish } from "@/pipeline/publish";
import { parseExistingFeed } from "@/pipeline/rss/parse";
import {
  TEST_CONFIG,
  TEST_VIDEOS,
  VID_AAA_INFO,
  VID_BBB_INFO,
  VID_CCC_INFO,
} from "@/pipeline/test-fixtures";
import { createMemoryFs } from "@/ports/memory-fs";
import { createSpyPorts, type SpiedPorts } from "@/ports/mock";
import type { Cache } from "@podpiper/dagraph";
import { MemCache } from "@podpiper/dagraph";
import type { Config, VideoInfo, YtDlpInfo } from "@/types";

function buildAndSync(
  videos: VideoInfo[],
  config: Config,
  ports: SpiedPorts,
  cache: Cache,
  opts?: { force?: boolean },
) {
  const { graph, refs } = buildPipelineGraph(videos, ports, config);
  return sync(
    graph,
    refs,
    ports.fs,
    { cache, fs: ports.fs, casBaseDir: config.casBaseDir },
    opts,
  );
}

function getUploadCalls(ports: SpiedPorts): { key: string; cacheControl?: string }[] {
  return ports.storage.uploadFile.mock.calls.map((c: unknown[]) => ({
    key: c[1] as string,
    ...(c[3] ? { cacheControl: c[3] as string } : {}),
  }));
}

describe("reprocess", () => {
  test("pulls metadata from re-downloaded info.json, not VideoInfo params", async () => {
    const allVideos: VideoInfo[] = [
      ...TEST_VIDEOS,
      { id: "vid_ccc", uploadDate: "20240320", title: "Video CCC" },
    ];

    const infoMap: Record<string, YtDlpInfo> = {
      vid_aaa: VID_AAA_INFO,
      vid_bbb: VID_BBB_INFO,
      vid_ccc: VID_CCC_INFO,
    };
    const audioContent: Record<string, string> = {
      vid_aaa: "fake-mp3-vid_aaa",
      vid_bbb: "fake-mp3-vid_bbb",
      vid_ccc: "fake-mp3-vid_ccc",
    };

    const sharedFs = createMemoryFs();
    const r2Bucket = new Map<string, Uint8Array>();
    const cache = new MemCache();

    function makePorts(): SpiedPorts {
      const ports = createSpyPorts(sharedFs, {
        ytdlp: {
          fetchVideoList: async () => [],
          fetchVideoTitles: async () => ({}),
          downloadAudio: async (outputDir: string, videoId: string) => {
            await sharedFs.writeText(`${outputDir}/audio.mp3`, audioContent[videoId]!);
            await sharedFs.writeText(
              `${outputDir}/audio.info.json`,
              JSON.stringify(infoMap[videoId]),
            );
            await sharedFs.writeText(`${outputDir}/audio.jpg`, `fake-thumb-${videoId}`);
          },
          downloadChannelArtwork: async (outputDir: string) => {
            await sharedFs.writeText(`${outputDir}/channel_avatar.jpg`, "fake-avatar");
          },
        },
      });
      // Passthrough so the audio bytes propagate to the upload; lets us assert R2 overwrite.
      ports.ffmpeg.embedChapters.mockImplementation(
        async (audio: string, _chapters: unknown, output: string) => {
          await sharedFs.writeText(output, await sharedFs.readText(audio));
        },
      );
      ports.storage.uploadFile.mockImplementation(async (data: Uint8Array, key: string) => {
        r2Bucket.set(key, data);
      });
      ports.storage.fileExists.mockImplementation(async (_bucket: string, key: string) =>
        r2Bucket.has(key),
      );
      ports.storage.getFile.mockImplementation(async (_bucket: string, key: string) =>
        r2Bucket.get(key) ?? null,
      );
      return ports;
    }

    // Run 1: full sync of all 3 videos with original metadata.
    const p1 = makePorts();
    const r1 = await buildAndSync(allVideos, TEST_CONFIG, p1, cache);
    await publish(r1, TEST_CONFIG, p1.fs, p1.storage, p1.clock.now);

    // YouTube returns updated metadata + new audio for vid_bbb on the next download.
    infoMap.vid_bbb = {
      id: "vid_bbb",
      title: "Growth Mindset Tips (Revised)",
      description: "An updated take on growth mindset.",
      upload_date: "20240312",
      duration: 2700,
    };
    audioContent.vid_bbb = "fake-mp3-vid_bbb-v2";

    // Run 2: reprocess only vid_bbb. VideoInfo.title/uploadDate set to dead strings
    // to prove they aren't read by the pipeline — metadata must come from yt-dlp's info.json.
    const p2 = makePorts();
    const subset: VideoInfo[] = [{ id: "vid_bbb", uploadDate: "", title: "" }];
    const r2 = await buildAndSync(subset, TEST_CONFIG, p2, cache, { force: true });
    await publish(r2, TEST_CONFIG, p2.fs, p2.storage, p2.clock.now, { force: true });

    const feedXml = await p2.fs.readText(`${TEST_CONFIG.outputDir}/feed.xml`);
    const feedEpisodes = parseExistingFeed(TEST_CONFIG.storage.publicUrl, feedXml)
      .map((e) => ({ id: e.id, title: e.title, uploadDate: e.uploadDate, duration: e.duration }))
      .sort((a, b) => a.id.localeCompare(b.id));

    expect({
      feedEpisodes,
      run2Uploads: getUploadCalls(p2).sort((a, b) => a.key.localeCompare(b.key)),
      bbbAudioOnR2: new TextDecoder().decode(r2Bucket.get("vid_bbb/audio.mp3")),
    }).toEqual({
      feedEpisodes: [
        { id: "vid_aaa", title: "Understanding Deep Learning", uploadDate: "20240315", duration: 1800 },
        { id: "vid_bbb", title: "Growth Mindset Tips (Revised)", uploadDate: "20240312", duration: 2700 },
        { id: "vid_ccc", title: "Intro to Rust Programming", uploadDate: "20240320", duration: 3600 },
      ],
      run2Uploads: [
        { key: "artwork.jpg", cacheControl: "max-age=86400" },
        { key: "feed.xml", cacheControl: "max-age=300" },
        { key: "vid_bbb/audio.mp3" },
        { key: "vid_bbb/thumbnail.jpg" },
        { key: "vid_bbb/transcript.srt" },
      ],
      bbbAudioOnR2: "fake-mp3-vid_bbb-v2",
    });
  });
});
