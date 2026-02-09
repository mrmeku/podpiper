import { describe, expect, test } from "bun:test";

import { extractReferencedUrls, parseExistingFeed } from "@/pipeline/rss/parse";
import { createMemoryFs } from "@/ports/memory-fs";
import type { SpiedPorts } from "@/ports/mock";
import { createSpyPorts } from "@/ports/mock";
import type { Config, VideoInfo, YtDlpInfo } from "@/types";
import { MemCache, TieredCache } from "@podpiper/dag/cache";
import type { Cache, ExecResult } from "@podpiper/dag/types";

import type { EpisodeOutput } from "@/pipeline/actions/rss-entry";
import { sync } from "@/pipeline/execute";
import { buildPipelineGraph } from "@/pipeline/graph-builder";
import { publish } from "@/pipeline/publish";

const TEST_CONFIG: Config = {
  channelUrl: "https://www.youtube.com/@testchannel",
  outputDir: "/test/output",
  r2: { bucket: "test-bucket", publicUrl: "https://cdn.test.com" },
  podcast: {
    title: "Test Podcast",
    author: "Test Author",
    description: "A test podcast",
    category: "Technology",
  },
  summaryPrompt: "Summarize this episode concisely.",
};

const TEST_VIDEOS: VideoInfo[] = [
  { id: "vid_aaa", uploadDate: "20240315", title: "Video AAA" },
  { id: "vid_bbb", uploadDate: "20240310", title: "Video BBB" },
];

const VID_AAA_INFO: YtDlpInfo = {
  id: "vid_aaa",
  title: "Understanding Deep Learning",
  description: "A video about deep learning.",
  upload_date: "20240315",
  duration: 1800,
  chapters: [
    { start_time: 0, end_time: 600, title: "Introduction" },
    { start_time: 600, end_time: 1200, title: "Core Concepts" },
    { start_time: 1200, end_time: 1800, title: "Conclusion" },
  ],
};

const VID_BBB_INFO: YtDlpInfo = {
  id: "vid_bbb",
  title: "Growth Mindset Tips",
  description: "A video about growth mindset.",
  upload_date: "20240310",
  duration: 2400,
};

const VID_CCC_INFO: YtDlpInfo = {
  id: "vid_ccc",
  title: "Intro to Rust Programming",
  description: "A video about Rust programming.",
  upload_date: "20240320",
  duration: 3600,
};

function createTestPorts() {
  const fs = createMemoryFs();
  const ports = createSpyPorts(fs, {
    ytdlp: {
      fetchVideoList: async () => [],
      downloadVideo: async (outputDir: string, videoId: string) => {
        const infoMap: Record<string, YtDlpInfo> = {
          vid_aaa: VID_AAA_INFO,
          vid_bbb: VID_BBB_INFO,
          vid_ccc: VID_CCC_INFO,
        };
        const info = infoMap[videoId] ?? VID_BBB_INFO;
        await fs.writeText(`${outputDir}/audio.mp3`, `fake-mp3-${videoId}`);
        await fs.writeText(`${outputDir}/audio.info.json`, JSON.stringify(info));
        await fs.writeText(`${outputDir}/audio.jpg`, `fake-thumb-${videoId}`);
      },
      downloadChannelArtwork: async (outputDir: string) => {
        await fs.writeText(`${outputDir}/channel_avatar.jpg`, "fake-avatar");
      },
    },
  });
  return { fs, ports };
}

function buildAndSync(
  videos: VideoInfo[],
  config: Config,
  ports: ReturnType<typeof createTestPorts>["ports"],
  cache: Cache,
  opts?: { maxParallelism?: number },
) {
  const { graph, refs } = buildPipelineGraph(cache, videos, ports, config);
  return sync(graph, refs, opts);
}

function countExec(results: ExecResult[]): {
  exec: number;
  skip: number;
  fail: number;
} {
  let exec = 0,
    skip = 0,
    fail = 0;
  for (const r of results) {
    if (r.status === "fail" || r.status === "dep-failed") fail++;
    else if (r.status === "cached") skip++;
    else exec++;
  }
  return { exec, skip, fail };
}

function getUploadCalls(ports: SpiedPorts): { key: string; cacheControl?: string }[] {
  return ports.storage.uploadFile.mock.calls.map((c: any) => ({
    key: c[1] as string,
    ...(c[3] ? { cacheControl: c[3] as string } : {}),
  }));
}

describe("sync pipeline", () => {
  test("fresh run executes full pipeline and publishes correct artifacts", async () => {
    const { ports } = createTestPorts();
    const cache = new MemCache();

    const sr = await buildAndSync(TEST_VIDEOS, TEST_CONFIG, ports, cache);
    const { exec, skip, fail } = countExec(sr.results);
    expect(fail).toBe(0);
    expect(skip).toBe(0);
    expect(exec).toBe(14);

    await publish(sr, TEST_CONFIG, ports.fs, ports.storage);

    // Episode data
    const aaaResult = sr.results.find((r) => r.name === "rss_entry:vid_aaa")!;
    const bbbResult = sr.results.find((r) => r.name === "rss_entry:vid_bbb")!;
    if (aaaResult.status !== "done" || bbbResult.status !== "done")
      throw new Error("expected done");
    const aaaEp = (JSON.parse(aaaResult.result) as EpisodeOutput).episode;
    const bbbEp = (JSON.parse(bbbResult.result) as EpisodeOutput).episode;

    expect({
      vid_aaa: {
        description: aaaEp.description,
        chapters: aaaEp.chapters.length,
        transcript: aaaEp.transcript,
        duration: aaaEp.duration,
      },
      vid_bbb: {
        description: bbbEp.description,
        chapters: bbbEp.chapters.length,
        transcript: bbbEp.transcript,
        duration: bbbEp.duration,
      },
    }).toEqual({
      vid_aaa: {
        description:
          "A video about deep learning.\n\n— Generated Summary —\n\nMock summary of the episode content.",
        chapters: 3,
        transcript: "vid_aaa/transcript.srt",
        duration: 1800,
      },
      vid_bbb: {
        description:
          "A video about growth mindset.\n\n— Generated Summary —\n\nMock summary of the episode content.",
        chapters: 0,
        transcript: "vid_bbb/transcript.srt",
        duration: 2400,
      },
    });

    // S3 uploads + port calls
    expect({
      downloads: ports.ytdlp.downloadVideo.mock.calls.map((c: any) => c[1]).sort(),
      cropThumbnails: ports.ffmpeg.cropThumbnail.mock.calls
        .map((c: any) => [
          (c[0] as string).split("/").slice(-2).join("/"),
          (c[1] as string).split("/").slice(-2).join("/"),
        ])
        .sort((a, b) => a[0]!.localeCompare(b[0]!)),
      processChannelArtwork: ports.ffmpeg.processChannelArtwork.mock.calls.length,
      claudePrompts: ports.claude.call.mock.calls.map((c: any) => c[0] as string).sort(),
      storageGetFile: ports.storage.getFile.mock.calls.length,
      uploads: getUploadCalls(ports).sort((a, b) => a.key.localeCompare(b.key)),
    }).toEqual({
      downloads: ["vid_aaa", "vid_bbb"],
      cropThumbnails: [
        ["vid_aaa/audio.jpg", "vid_aaa/thumbnail.jpg"],
        ["vid_bbb/audio.jpg", "vid_bbb/thumbnail.jpg"],
      ],
      processChannelArtwork: 1,
      claudePrompts: [
        expect.stringContaining("Growth Mindset"),
        expect.stringContaining("Deep Learning"),
      ],
      storageGetFile: 1,
      uploads: [
        { key: "artwork.jpg", cacheControl: "max-age=86400" },
        { key: "feed.xml", cacheControl: "max-age=300" },
        { key: "vid_aaa/audio.mp3" },
        { key: "vid_aaa/chapters.json" },
        { key: "vid_aaa/thumbnail.jpg" },
        { key: "vid_aaa/transcript.srt" },
        { key: "vid_bbb/audio.mp3" },
        { key: "vid_bbb/thumbnail.jpg" },
        { key: "vid_bbb/transcript.srt" },
      ],
    });

    // Feed XML
    const feedXml = await ports.fs.readText(`${TEST_CONFIG.outputDir}/feed.xml`);
    const stableFeedXml = feedXml.replace(
      /<lastBuildDate>.*<\/lastBuildDate>/,
      "<lastBuildDate>STABLE</lastBuildDate>",
    );
    expect(stableFeedXml).toMatchSnapshot();
  });

  test("second run with same inputs caches all DAG nodes but still publishes feed", async () => {
    const { ports } = createTestPorts();
    const cache = new MemCache();

    const r1 = await buildAndSync(TEST_VIDEOS, TEST_CONFIG, ports, cache);
    await publish(r1, TEST_CONFIG, ports.fs, ports.storage);
    expect({
      dag: countExec(r1.results),
      downloads: ports.ytdlp.downloadVideo.mock.calls.length,
      uploads: ports.storage.uploadFile.mock.calls.length,
    }).toEqual({
      dag: { exec: 14, skip: 0, fail: 0 },
      downloads: 2,
      uploads: 9,
    });

    ports.ytdlp.downloadVideo.mockClear();
    ports.storage.uploadFile.mockClear();

    const r2 = await buildAndSync(TEST_VIDEOS, TEST_CONFIG, ports, cache);
    await publish(r2, TEST_CONFIG, ports.fs, ports.storage);
    expect({
      dag: countExec(r2.results),
      downloads: ports.ytdlp.downloadVideo.mock.calls.length,
      uploads: ports.storage.uploadFile.mock.calls.length,
    }).toEqual({
      dag: { exec: 0, skip: 14, fail: 0 },
      downloads: 0,
      uploads: 1,
    });
    expect(getUploadCalls(ports)).toEqual([{ key: "feed.xml", cacheControl: "max-age=300" }]);
  });

  test("empty local cache pulls from remote and skips all nodes", async () => {
    const { ports } = createTestPorts();
    const remote = new MemCache();

    const r1 = await buildAndSync(
      TEST_VIDEOS,
      TEST_CONFIG,
      ports,
      new TieredCache({ local: new MemCache(), remote }),
    );
    await publish(r1, TEST_CONFIG, ports.fs, ports.storage);
    expect({
      dag: countExec(r1.results),
      downloads: ports.ytdlp.downloadVideo.mock.calls.length,
      uploads: ports.storage.uploadFile.mock.calls.length,
    }).toEqual({
      dag: { exec: 14, skip: 0, fail: 0 },
      downloads: 2,
      uploads: 9,
    });

    ports.ytdlp.downloadVideo.mockClear();
    ports.storage.uploadFile.mockClear();

    const r2 = await buildAndSync(
      TEST_VIDEOS,
      TEST_CONFIG,
      ports,
      new TieredCache({ local: new MemCache(), remote }),
    );
    await publish(r2, TEST_CONFIG, ports.fs, ports.storage);
    expect({
      dag: countExec(r2.results),
      downloads: ports.ytdlp.downloadVideo.mock.calls.length,
      uploads: ports.storage.uploadFile.mock.calls.length,
    }).toEqual({
      dag: { exec: 0, skip: 14, fail: 0 },
      downloads: 0,
      uploads: 1,
    });
  });

  test("new episode added to warm cache only processes new video", async () => {
    const cache = new MemCache();

    // Run 1: warm cache with vid_aaa + vid_bbb
    const { ports: p1 } = createTestPorts();
    await buildAndSync(TEST_VIDEOS, TEST_CONFIG, p1, cache);

    // Run 2: add vid_ccc
    const allVideos: VideoInfo[] = [
      ...TEST_VIDEOS,
      { id: "vid_ccc", uploadDate: "20240320", title: "Video CCC" },
    ];
    const { ports: p2 } = createTestPorts();
    const r2 = await buildAndSync(allVideos, TEST_CONFIG, p2, cache);
    await publish(r2, TEST_CONFIG, p2.fs, p2.storage);

    // DAG execution: 6 new nodes for vid_ccc, 14 cached (no feed node)
    expect(countExec(r2.results)).toEqual({ exec: 6, skip: 14, fail: 0 });

    // All 3 episodes available (including cached ones)
    expect(r2.episodes.length).toBe(3);

    // New episode data
    const cccResult = r2.results.find((r) => r.name === "rss_entry:vid_ccc")!;
    if (cccResult.status !== "done") throw new Error("expected done");
    const cccEp = (JSON.parse(cccResult.result) as EpisodeOutput).episode;
    expect({
      description: cccEp.description,
      chapters: cccEp.chapters.length,
      transcript: cccEp.transcript,
      duration: cccEp.duration,
    }).toEqual({
      description:
        "A video about Rust programming.\n\n— Generated Summary —\n\nMock summary of the episode content.",
      chapters: 0,
      transcript: "vid_ccc/transcript.srt",
      duration: 3600,
    });

    // Port calls + uploads (fresh ports, only captures run 2 calls)
    expect({
      downloads: p2.ytdlp.downloadVideo.mock.calls.map((c: any) => c[1]),
      cropThumbnails: p2.ffmpeg.cropThumbnail.mock.calls.map((c: any) => [
        (c[0] as string).split("/").slice(-2).join("/"),
        (c[1] as string).split("/").slice(-2).join("/"),
      ]),
      processChannelArtwork: p2.ffmpeg.processChannelArtwork.mock.calls.length,
      claudePrompts: p2.claude.call.mock.calls.map((c: any) => c[0] as string),
      storageGetFile: p2.storage.getFile.mock.calls.length,
      uploads: getUploadCalls(p2).sort((a, b) => a.key.localeCompare(b.key)),
    }).toEqual({
      downloads: ["vid_ccc"],
      cropThumbnails: [["vid_ccc/audio.jpg", "vid_ccc/thumbnail.jpg"]],
      processChannelArtwork: 0,
      claudePrompts: [expect.stringContaining("Mock transcript")],
      storageGetFile: 1,
      uploads: [
        { key: "feed.xml", cacheControl: "max-age=300" },
        { key: "vid_ccc/audio.mp3" },
        { key: "vid_ccc/thumbnail.jpg" },
        { key: "vid_ccc/transcript.srt" },
      ],
    });

    // Sanity: third run with all 3 videos fully cached
    const { ports: p3 } = createTestPorts();
    const r3 = await buildAndSync(allVideos, TEST_CONFIG, p3, cache);
    await publish(r3, TEST_CONFIG, p3.fs, p3.storage);
    expect({
      run3: countExec(r3.results),
      downloadCalls: p3.ytdlp.downloadVideo.mock.calls.length,
      uploadCalls: p3.storage.uploadFile.mock.calls.length,
    }).toEqual({
      run3: { exec: 0, skip: 20, fail: 0 },
      downloadCalls: 0,
      uploadCalls: 1,
    });
  });

  test("uploaded files match URLs referenced in feed.xml", async () => {
    const { ports } = createTestPorts();
    const sr = await buildAndSync(TEST_VIDEOS, TEST_CONFIG, ports, new MemCache());
    await publish(sr, TEST_CONFIG, ports.fs, ports.storage);
    const feedXml = await ports.fs.readText(`${TEST_CONFIG.outputDir}/feed.xml`);
    const prefix = TEST_CONFIG.r2.publicUrl + "/";
    const referencedKeys = extractReferencedUrls(feedXml)
      .map((u) => decodeURIComponent(u.replace(prefix, "")))
      .sort();
    const uploadedKeys = sr.uploads.map((u) => u.r2Key).sort();
    expect(uploadedKeys).toEqual(referencedKeys);
  });

  test("partial cache eviction re-executes only evicted nodes", async () => {
    const store = new Map<string, string>();
    const cache: Cache & { evict(hash: string): void } = {
      get: (hash) => {
        const r = store.get(hash);
        return r !== undefined ? [r, true] : ["", false];
      },
      put: (hash, result) => store.set(hash, result),
      evict: (hash) => store.delete(hash),
    };
    const { ports } = createTestPorts();

    const r1 = await buildAndSync(TEST_VIDEOS, TEST_CONFIG, ports, cache);
    await publish(r1, TEST_CONFIG, ports.fs, ports.storage);
    expect(countExec(r1.results)).toEqual({ exec: 14, skip: 0, fail: 0 });

    for (const r of r1.results) {
      if (r.name === "rss_entry:vid_aaa" || r.name === "artwork") {
        cache.evict(r.hash);
      }
    }
    ports.storage.uploadFile.mockClear();

    const r2 = await buildAndSync(TEST_VIDEOS, TEST_CONFIG, ports, cache);
    await publish(r2, TEST_CONFIG, ports.fs, ports.storage);
    expect(countExec(r2.results)).toEqual({ exec: 2, skip: 12, fail: 0 });
    expect(getUploadCalls(ports).sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { key: "artwork.jpg", cacheControl: "max-age=86400" },
      { key: "feed.xml", cacheControl: "max-age=300" },
      { key: "vid_aaa/audio.mp3" },
      { key: "vid_aaa/chapters.json" },
      { key: "vid_aaa/thumbnail.jpg" },
      { key: "vid_aaa/transcript.srt" },
    ]);
  });

  test("force-reprocess subset preserves existing episodes in feed", async () => {
    const allVideos: VideoInfo[] = [
      ...TEST_VIDEOS,
      { id: "vid_ccc", uploadDate: "20240320", title: "Video CCC" },
    ];

    // Run 1: process all 3 videos
    const { fs: fs1, ports: p1 } = createTestPorts();
    const sr1 = await buildAndSync(allVideos, TEST_CONFIG, p1, new MemCache());
    await publish(sr1, TEST_CONFIG, p1.fs, p1.storage);
    const feedAfterRun1 = await fs1.readText(`${TEST_CONFIG.outputDir}/feed.xml`);

    // Run 2: force-reprocess first 2 only (simulates -f -n 2)
    const { ports: p2 } = createTestPorts();
    p2.storage.getFile.mockImplementation(async (_bucket: string, key: string) => {
      if (key === "feed.xml") return new TextEncoder().encode(feedAfterRun1);
      return null;
    });
    const subset = allVideos.slice(0, 2);
    const sr2 = await buildAndSync(subset, TEST_CONFIG, p2, new MemCache());
    await publish(sr2, TEST_CONFIG, p2.fs, p2.storage);

    expect({
      dag: countExec(sr2.results),
      syncEpisodes: sr2.episodes.length,
      feedEpisodes: parseExistingFeed(
        TEST_CONFIG.r2.publicUrl,
        await p2.fs.readText(`${TEST_CONFIG.outputDir}/feed.xml`),
      )
        .map((e) => e.id)
        .sort(),
      uploads: getUploadCalls(p2).sort((a, b) => a.key.localeCompare(b.key)),
    }).toEqual({
      dag: { exec: 14, skip: 0, fail: 0 },
      syncEpisodes: 2,
      feedEpisodes: ["vid_aaa", "vid_bbb", "vid_ccc"],
      uploads: [
        { key: "artwork.jpg", cacheControl: "max-age=86400" },
        { key: "feed.xml", cacheControl: "max-age=300" },
        { key: "vid_aaa/audio.mp3" },
        { key: "vid_aaa/chapters.json" },
        { key: "vid_aaa/thumbnail.jpg" },
        { key: "vid_aaa/transcript.srt" },
        { key: "vid_bbb/audio.mp3" },
        { key: "vid_bbb/thumbnail.jpg" },
        { key: "vid_bbb/transcript.srt" },
      ],
    });
  });

  test("tiered cache promotes remote hits to local", async () => {
    const remote = new MemCache();
    const { ports: p1 } = createTestPorts();
    const r1 = await buildAndSync(TEST_VIDEOS, TEST_CONFIG, p1, remote);
    expect(countExec(r1.results).exec).toBe(14);

    const local = new MemCache();
    const tiered = new TieredCache({ local, remote });
    const { ports: p2 } = createTestPorts();
    const r2 = await buildAndSync(TEST_VIDEOS, TEST_CONFIG, p2, tiered);
    expect(countExec(r2.results).skip).toBe(14);
    expect(countExec(r2.results).exec).toBe(0);

    // Local is now warm from remote promotion
    const { ports: p3 } = createTestPorts();
    const r3 = await buildAndSync(TEST_VIDEOS, TEST_CONFIG, p3, local);
    expect(countExec(r3.results).skip).toBe(14);
    expect(countExec(r3.results).exec).toBe(0);
  });
});
