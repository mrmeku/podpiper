import { describe, expect, test } from "bun:test";

import { MemCache, type ExecutionContext } from "@podpiper/dagraph";

import { sync } from "@/pipeline/execute";
import { buildPipelineGraph, videoPipelineTopology } from "@/pipeline/graph-builder";
import { publish } from "@/pipeline/publish";
import { createTestPorts, TEST_CONFIG, TEST_VIDEOS } from "@/pipeline/test-fixtures";

import type { SpiedPorts } from "@/ports/mock";
import { toHatchetVideoWorkflow } from "./adapter";
import { registerChannelWorkflow } from "./channel-workflow";
import { createFakeHatchet, runFakeWorkflow } from "./test-helpers";

function getUploadCalls(ports: SpiedPorts) {
  return ports.storage.uploadFile.mock.calls
    .map((c: any) => ({ key: c[1] as string, ...(c[3]?.cacheControl ? { cacheControl: c[3].cacheControl as string } : {}) }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function registerWorkflows(ports: ReturnType<typeof createTestPorts>["ports"]) {
  const { hatchet, getWorkflow, workflows } = createFakeHatchet();
  const topology = videoPipelineTopology(ports, TEST_CONFIG);
  const executionCtx: ExecutionContext = {
    cache: new MemCache(),
    fs: ports.fs,
    casBaseDir: `${TEST_CONFIG.outputDir}/cas`,
  };
  const videoPipeline = toHatchetVideoWorkflow(
    hatchet,
    "video",
    topology,
    ports,
    TEST_CONFIG,
    executionCtx,
  );
  return { hatchet, getWorkflow, workflows, videoPipeline };
}

describe("hatchet serve", () => {
  test("hatchet workflow produces identical feed.xml as sync pipeline", async () => {
    // Sync pipeline (reference)
    const { ports: syncPorts } = createTestPorts();
    const { graph, refs } = buildPipelineGraph(TEST_VIDEOS, syncPorts, TEST_CONFIG);
    const executionCtx: ExecutionContext = {
      cache: new MemCache(),
      fs: syncPorts.fs,
      casBaseDir: `${TEST_CONFIG.outputDir}/cas`,
    };
    const sr = await sync(graph, refs, syncPorts.fs, executionCtx);
    await publish(sr, TEST_CONFIG, syncPorts.fs, syncPorts.storage);
    const syncFeedXml = await syncPorts.fs.readText(`${TEST_CONFIG.outputDir}/feed.xml`);

    // Hatchet workflow (same ports/config, fake orchestrator)
    const { ports: hatchetPorts } = createTestPorts();
    const { hatchet, getWorkflow, workflows, videoPipeline } = registerWorkflows(hatchetPorts);
    hatchetPorts.ytdlp.fetchVideoList.mockImplementation(async () => TEST_VIDEOS);
    registerChannelWorkflow(hatchet, "ch", TEST_CONFIG, hatchetPorts, videoPipeline);
    await runFakeWorkflow(getWorkflow("ch-sync"), {}, workflows);
    const hatchetFeedXml = await hatchetPorts.fs.readText(`${TEST_CONFIG.outputDir}/feed.xml`);

    expect(hatchetFeedXml).toEqual(syncFeedXml);
    expect(getUploadCalls(hatchetPorts)).toEqual(getUploadCalls(syncPorts));
  });

  test("channel workflow tasks form correct dependency DAG", () => {
    const { ports } = createTestPorts();
    const { hatchet, getWorkflow, videoPipeline } = registerWorkflows(ports);
    registerChannelWorkflow(hatchet, "ch", TEST_CONFIG, ports, videoPipeline);

    expect(getWorkflow("ch-sync").tasks.map((t) => ({ name: t.name, parents: t.parents }))).toEqual(
      [
        { name: "discover", parents: [] },
        { name: "process-videos", parents: ["discover"] },
        { name: "channel-avatar", parents: ["discover"] },
        { name: "artwork", parents: ["channel-avatar"] },
        { name: "publish", parents: ["process-videos", "artwork"] },
      ],
    );
  });

  test("video pipeline topology maps to correct Hatchet task parents", () => {
    const { ports } = createTestPorts();
    const topology = videoPipelineTopology(ports, TEST_CONFIG);
    const { getWorkflow } = registerWorkflows(ports);

    expect(getWorkflow("video").tasks.map((t) => ({ name: t.name, parents: t.parents }))).toEqual(
      topology.map((e) => ({ name: e.kind, parents: e.depKinds })),
    );
  });

  test("discover filters out videos already in existing feed", async () => {
    const { ports } = createTestPorts();
    const allVideos = [
      { id: "vid_aaa", uploadDate: "20240315", title: "Video AAA" },
      { id: "vid_bbb", uploadDate: "20240310", title: "Video BBB" },
      { id: "vid_ccc", uploadDate: "20240320", title: "Video CCC" },
    ];
    ports.ytdlp.fetchVideoList.mockImplementation(async () => allVideos);
    const existingFeedXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel><item><guid>vid_aaa</guid><enclosure url="https://cdn.test.com/vid_aaa/audio.mp3"/></item></channel></rss>`;
    ports.storage.getFile.mockImplementation(async (_bucket: string, key: string) => {
      if (key === "feed.xml") return new TextEncoder().encode(existingFeedXml);
      return null;
    });

    const { hatchet, getWorkflow, videoPipeline } = registerWorkflows(ports);
    registerChannelWorkflow(hatchet, "ch", TEST_CONFIG, ports, videoPipeline);
    const discoverTask = getWorkflow("ch-sync").tasks.find((t) => t.name === "discover")!;
    const result = (await discoverTask.fn({}, { log: async () => {} })) as {
      videos: typeof allVideos;
    };
    expect(result.videos.map((v) => v.id)).toEqual(["vid_bbb", "vid_ccc"]);
  });

  test("workflow includes cron schedule when provided", () => {
    const { ports } = createTestPorts();
    const { hatchet, getWorkflow, videoPipeline } = registerWorkflows(ports);
    registerChannelWorkflow(hatchet, "ch", TEST_CONFIG, ports, videoPipeline, "0 3 * * *");
    expect(getWorkflow("ch-sync").opts.on).toEqual({ cron: "0 3 * * *" });
  });
});
