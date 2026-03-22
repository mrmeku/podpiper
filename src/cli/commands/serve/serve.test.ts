import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, DefaultLogger, Runtime, Worker, type WorkflowBundleWithSourceMap } from "@temporalio/worker";
import path from "node:path";

import { MemCache, type ExecutionContext } from "@podpiper/dagraph";

import { sync } from "@/pipeline/execute";
import { buildPipelineGraph, buildVideoGraph } from "@/pipeline/graph-builder";
import { publish } from "@/pipeline/publish";
import { createTestPorts, TEST_CONFIG, TEST_VIDEOS } from "@/pipeline/test-fixtures";

import type { SpiedPorts } from "@/ports/mock";
import { TEMPORAL_TASK_CONFIG, TASK_QUEUES } from "./task-config";
import { NodeKind } from "@/pipeline/actions/define-action";
import { createActivities } from "./activities";
import { webpackConfigHook, WORKFLOW_BUNDLER_IGNORE_MODULES } from "./bundler-config";
import type { ChannelWorkflowInput } from "./workflows";

function getUploadCalls(ports: SpiedPorts) {
  return ports.storage.uploadFile.mock.calls
    .map((c: any) => ({ key: c[1] as string, ...(c[3] ? { cacheControl: c[3] as string } : {}) }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

// ---------- Temporal test environment (shared across tests) ----------

let testEnv: TestWorkflowEnvironment;
let workflowBundle: WorkflowBundleWithSourceMap;

beforeAll(async () => {
  const logger = new DefaultLogger("ERROR");
  Runtime.install({ logger });
  workflowBundle = await bundleWorkflowCode({
    workflowsPath: path.resolve(import.meta.dirname, "./workflows.ts"),
    webpackConfigHook,
    ignoreModules: WORKFLOW_BUNDLER_IGNORE_MODULES,
    logger,
  });
  testEnv = await TestWorkflowEnvironment.createLocal({
    server: { log: { format: "pretty", level: "error" } },
  });
}, 60_000);

afterAll(async () => {
  await testEnv?.teardown();
});

/**
 * Start workers for all task queues (workflows + 3 activity queues),
 * run `fn` while workers are alive, then shut them down.
 */
async function withWorkers<T>(
  activities: ReturnType<typeof createActivities>,
  fn: () => Promise<T>,
): Promise<T> {
  const activityQueues = [TASK_QUEUES.default, TASK_QUEUES.whisper, TASK_QUEUES.claude];

  const workers = await Promise.all([
    Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: TASK_QUEUES.workflows,
      workflowBundle,
    }),
    ...activityQueues.map((taskQueue) =>
      Worker.create({
        connection: testEnv.nativeConnection,
        taskQueue,
        activities,
      }),
    ),
  ]);

  // runUntil starts all workers, runs fn, then shuts workers down
  // We need to run all workers concurrently with the workflow execution
  const workerPromises = workers.map((w) => w.run());
  try {
    const result = await fn();
    return result;
  } finally {
    workers.forEach((w) => w.shutdown());
    await Promise.all(workerPromises);
  }
}

describe("temporal serve", () => {
  test("channelWorkflow through Temporal produces identical feed.xml as sync pipeline", async () => {
    // ---- Reference: sync pipeline ----
    const { ports: syncPorts } = createTestPorts();
    const { graph, refs } = buildPipelineGraph(TEST_VIDEOS, syncPorts, TEST_CONFIG);
    const syncCtx: ExecutionContext = {
      cache: new MemCache(),
      fs: syncPorts.fs,
      casBaseDir: `${TEST_CONFIG.outputDir}/cas`,
    };
    const sr = await sync(graph, refs, syncPorts.fs, syncCtx);
    await publish(sr, TEST_CONFIG, syncPorts.fs, syncPorts.storage, syncPorts.clock.now);
    const syncFeedXml = await syncPorts.fs.readText(`${TEST_CONFIG.outputDir}/feed.xml`);

    // ---- Temporal: channelWorkflow via test server ----
    const { ports: temporalPorts } = createTestPorts();
    temporalPorts.ytdlp.fetchVideoList.mockImplementation(async () => TEST_VIDEOS);
    const temporalCtx: ExecutionContext = {
      cache: new MemCache(),
      fs: temporalPorts.fs,
      casBaseDir: `${TEST_CONFIG.outputDir}/cas`,
    };
    const activities = createActivities(temporalPorts, TEST_CONFIG, temporalCtx);

    await withWorkers(activities, async () => {
      await testEnv.client.workflow.execute<(input: ChannelWorkflowInput) => Promise<void>>(
        "channelWorkflow",
        {
          taskQueue: TASK_QUEUES.workflows,
          workflowId: "test-channel",
          args: [{ channelName: "test" }],
        },
      );
    });

    const temporalFeedXml = await temporalPorts.fs.readText(`${TEST_CONFIG.outputDir}/feed.xml`);
    expect(temporalFeedXml).toEqual(syncFeedXml);
    expect(getUploadCalls(temporalPorts)).toEqual(getUploadCalls(syncPorts));
  }, 60_000);

  test("task config covers all node kinds with correct task queues", () => {
    for (const kind of Object.values(NodeKind)) {
      expect(TEMPORAL_TASK_CONFIG[kind]).toBeDefined();
      expect(TEMPORAL_TASK_CONFIG[kind].taskQueue).toBeTruthy();
      expect(TEMPORAL_TASK_CONFIG[kind].startToCloseTimeout).toBeTruthy();
    }

    // Whisper goes to whisper queue
    expect(TEMPORAL_TASK_CONFIG[NodeKind.Transcribe].taskQueue).toBe(TASK_QUEUES.whisper);

    // Claude tasks go to claude queue
    expect(TEMPORAL_TASK_CONFIG[NodeKind.Chapters].taskQueue).toBe(TASK_QUEUES.claude);
    expect(TEMPORAL_TASK_CONFIG[NodeKind.Summary].taskQueue).toBe(TASK_QUEUES.claude);

    // Others go to default queue
    expect(TEMPORAL_TASK_CONFIG[NodeKind.Download].taskQueue).toBe(TASK_QUEUES.default);
    expect(TEMPORAL_TASK_CONFIG[NodeKind.Thumbnail].taskQueue).toBe(TASK_QUEUES.default);
    expect(TEMPORAL_TASK_CONFIG[NodeKind.RssEntry].taskQueue).toBe(TASK_QUEUES.default);
  });

  test("discover filters out videos already in existing feed", async () => {
    const { ports } = createTestPorts();
    const executionCtx: ExecutionContext = {
      cache: new MemCache(),
      fs: ports.fs,
      casBaseDir: `${TEST_CONFIG.outputDir}/cas`,
    };
    const activities = createActivities(ports, TEST_CONFIG, executionCtx);

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

    const result = await activities.discover();
    expect(result.videos.map((v) => v.video.id)).toEqual(["vid_bbb", "vid_ccc"]);
  });

  test("Graph.describe() returns serializable descriptors", () => {
    const { ports } = createTestPorts();
    const video = TEST_VIDEOS[0]!;
    const graph = buildVideoGraph(video, ports, TEST_CONFIG);
    const descriptors = graph.describe();

    // Descriptors should be JSON-serializable (no closures)
    const serialized = JSON.parse(JSON.stringify(descriptors));
    expect(serialized).toEqual(descriptors);

    // Each descriptor should have required fields
    for (const desc of descriptors) {
      expect(typeof desc.name).toBe("string");
      expect(typeof desc.kind).toBe("string");
      expect(Array.isArray(desc.deps)).toBe(true);
      expect(typeof desc.config).toBe("string");
    }
  });
});
