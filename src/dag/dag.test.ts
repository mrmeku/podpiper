import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { LocalCache, MemCache, TieredCache } from "./cache";
import { Graph, localRunner } from "./graph";
import type { ExecResult, NodeRunner, ProgressEvent } from "./types";

function countExec(results: ExecResult[]): { exec: number; skip: number } {
  let exec = 0;
  let skip = 0;
  for (const r of results) {
    if (r.status === "fail" || r.status === "dep-failed") continue;
    if (r.status === "cached") skip++;
    else exec++;
  }
  return { exec, skip };
}

function addVideoNodes(g: Graph, vid: string): void {
  const n = (kind: string) => `${kind}:${vid}`;
  g.add({
    name: n("video"),
    kind: "video",
    deps: [],
    config: vid,
    action: async () => `{"id":"${vid}"}`,
  });
  g.add({
    name: n("audio"),
    kind: "audio",
    deps: [n("video")],
    config: "format=mp3,bitrate=192k",
    action: async () => `/data/audio/${vid}.mp3`,
  });
  g.add({
    name: n("transcript"),
    kind: "transcript",
    deps: [n("audio")],
    config: "model=whisper-large-v3",
    action: async () => `Transcript of ${vid}`,
  });
  g.add({
    name: n("summary"),
    kind: "summary",
    deps: [n("transcript")],
    config: "prompt=v2,model=claude-sonnet",
    action: async () => `Summary of ${vid}`,
  });
  g.add({
    name: n("chapters"),
    kind: "chapters",
    deps: [n("transcript")],
    config: "prompt=v1,model=claude-sonnet",
    action: async () => "00:00 Intro",
  });
  g.add({
    name: n("thumbnail"),
    kind: "thumbnail",
    deps: [n("video")],
    config: "style=podcast-v2",
    action: async () => `/data/thumb/${vid}.png`,
  });
  g.add({
    name: n("rss_entry"),
    kind: "rss_entry",
    deps: [n("summary"), n("chapters"), n("audio"), n("thumbnail")],
    config: "feed=v1",
    action: async () => `<item>${vid}</item>`,
  });
}

function addFeedNode(g: Graph, vids: string[]): void {
  const deps = vids.map((vid) => `rss_entry:${vid}`);
  g.add({
    name: "feed",
    kind: "feed",
    deps,
    config: "feed_format=rss2.0",
    action: async (inputs) => {
      const entries = Object.values(inputs);
      return `<rss>${entries.join("")}</rss>`;
    },
  });
}

function buildGraph(cache: MemCache | LocalCache | TieredCache, vids: string[]): Graph {
  const g = new Graph(cache);
  for (const vid of vids) addVideoNodes(g, vid);
  addFeedNode(g, vids);
  return g;
}

describe("Graph", () => {
  test("incremental videos", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "dag-test-"));
    const cache = new LocalCache(join(tempDir, "cache.json"));

    // Run 1: 2 videos, all fresh
    let results = await buildGraph(cache, ["vid_aaa", "vid_bbb"]).execute();
    let { exec, skip } = countExec(results);
    expect(skip).toBe(0);
    expect(exec).toBe(15); // 7 per video + 1 feed

    // Run 2: same 2 videos, all cached
    results = await buildGraph(cache, ["vid_aaa", "vid_bbb"]).execute();
    ({ exec, skip } = countExec(results));
    expect(exec).toBe(0);
    expect(skip).toBe(15);

    // Run 3: new video vid_ccc
    results = await buildGraph(cache, ["vid_aaa", "vid_bbb", "vid_ccc"]).execute();
    ({ exec, skip } = countExec(results));
    expect(exec).toBe(8); // 7 for vid_ccc + 1 feed (deps changed)
    expect(skip).toBe(14); // 7 for vid_aaa + 7 for vid_bbb
  });

  test("tiered cache", async () => {
    const remote = new MemCache();
    const local = new MemCache();

    // Pre-warm remote
    let results = await buildGraph(remote, ["vid_aaa"]).execute();
    let { exec } = countExec(results);
    expect(exec).toBe(8);

    // Tiered: local miss -> remote hit -> pull into local
    const tiered = new TieredCache({ local, remote });
    results = await buildGraph(tiered, ["vid_aaa"]).execute();
    ({ exec } = countExec(results));
    expect(exec).toBe(0);

    // Local is now warm
    results = await buildGraph(local, ["vid_aaa"]).execute();
    ({ exec } = countExec(results));
    expect(exec).toBe(0);
  });

  describe("plan()", () => {
    test("all dirty on fresh cache", () => {
      const cache = new MemCache();
      const plan = buildGraph(cache, ["vid_aaa", "vid_bbb"]).plan();
      expect(plan.totalCounts).toEqual({ total: 15, cached: 0, dirty: 15 });
    });

    test("all cached after execute", async () => {
      const cache = new MemCache();
      await buildGraph(cache, ["vid_aaa", "vid_bbb"]).execute();
      const plan = buildGraph(cache, ["vid_aaa", "vid_bbb"]).plan();
      expect(plan.totalCounts).toEqual({ total: 15, cached: 15, dirty: 0 });
    });

    test("incremental new video", async () => {
      const cache = new MemCache();
      await buildGraph(cache, ["vid_aaa", "vid_bbb"]).execute();
      const plan = buildGraph(cache, ["vid_aaa", "vid_bbb", "vid_ccc"]).plan();
      expect(plan.totalCounts.cached).toBe(14);
      expect(plan.totalCounts.dirty).toBe(8);
    });

    test("byKind breakdown", () => {
      const cache = new MemCache();
      const plan = buildGraph(cache, ["vid_aaa", "vid_bbb"]).plan();
      const toNodeCounds = (total: number) => ({
        total,
        cached: 0,
        dirty: total,
      });
      expect(Object.fromEntries(plan.byKind)).toEqual({
        video: toNodeCounds(2),
        audio: toNodeCounds(2),
        transcript: toNodeCounds(2),
        summary: toNodeCounds(2),
        chapters: toNodeCounds(2),
        thumbnail: toNodeCounds(2),
        rss_entry: toNodeCounds(2),
        feed: toNodeCounds(1),
      });
    });

    test("plan agrees with execute", async () => {
      const cache = new MemCache();
      await buildGraph(cache, ["vid_aaa"]).execute();
      const g = buildGraph(cache, ["vid_aaa", "vid_bbb"]);
      const plan = g.plan();
      const results = await g.execute();
      const { exec, skip } = countExec(results);
      expect(plan.totalCounts.dirty).toBe(exec);
      expect(plan.totalCounts.cached).toBe(skip);
    });
  });

  test("readiness: dependent starts as soon as its deps finish", async () => {
    const cache = new MemCache();
    const g = new Graph(cache);
    const log: string[] = [];

    g.add({
      name: "slow_root",
      kind: "root",
      deps: [],
      config: "a",
      action: async () => {
        await Bun.sleep(50);
        log.push("slow_root");
        return "a";
      },
    });
    g.add({
      name: "fast_root",
      kind: "root",
      deps: [],
      config: "b",
      action: async () => {
        log.push("fast_root");
        return "b";
      },
    });
    g.add({
      name: "slow_child",
      kind: "child",
      deps: ["slow_root"],
      config: "c",
      action: async () => {
        log.push("slow_child");
        return "c";
      },
    });
    g.add({
      name: "fast_child",
      kind: "child",
      deps: ["fast_root"],
      config: "d",
      action: async () => {
        log.push("fast_child");
        return "d";
      },
    });

    await g.execute();
    expect(log).toEqual(["fast_root", "fast_child", "slow_root", "slow_child"]);
  });

  test("children of completed nodes run before queued siblings", async () => {
    const cache = new MemCache();
    const g = new Graph(cache);
    const log: string[] = [];

    g.add({
      name: "first_root",
      kind: "root",
      deps: [],
      config: "r1",
      action: async () => {
        log.push("first_root");
        return "r1";
      },
    });
    g.add({
      name: "second_root",
      kind: "root",
      deps: [],
      config: "r2",
      action: async () => {
        log.push("second_root");
        return "r2";
      },
    });
    g.add({
      name: "child",
      kind: "child",
      deps: ["first_root"],
      config: "c1",
      action: async () => {
        log.push("child");
        return "c1";
      },
    });

    await g.execute(localRunner, { maxParallelism: 1 });
    expect(log).toEqual(["first_root", "child", "second_root"]);
  });

  test("config change rollback", async () => {
    const cache = new MemCache();
    let summaryPrompt = "prompt=v2";

    const makeGraph = () => {
      const g = new Graph(cache);
      const vid = "vid_aaa";
      const n = (kind: string) => `${kind}:${vid}`;
      g.add({
        name: n("video"),
        kind: "video",
        deps: [],
        config: vid,
        action: async () => `{"id":"${vid}"}`,
      });
      g.add({
        name: n("audio"),
        kind: "audio",
        deps: [n("video")],
        config: "mp3",
        action: async () => `/audio/${vid}`,
      });
      g.add({
        name: n("transcript"),
        kind: "transcript",
        deps: [n("audio")],
        config: "whisper-v3",
        action: async () => "transcript",
      });
      g.add({
        name: n("summary"),
        kind: "summary",
        deps: [n("transcript")],
        config: summaryPrompt,
        action: async () => "summary",
      });
      return g;
    };

    // Fresh
    let results = await makeGraph().execute();
    let { exec, skip } = countExec(results);
    expect(exec).toBe(4);
    expect(skip).toBe(0);

    // Change prompt - only summary re-executes
    summaryPrompt = "prompt=v3";
    results = await makeGraph().execute();
    ({ exec, skip } = countExec(results));
    expect(exec).toBe(1);

    // Rollback - content-addressed hit
    summaryPrompt = "prompt=v2";
    results = await makeGraph().execute();
    ({ exec, skip } = countExec(results));
    expect(exec).toBe(0);
  });

  test("mock runner: executor calls runner instead of node.action", async () => {
    const cache = new MemCache();
    const g = new Graph(cache);
    const calls: string[] = [];

    g.add({
      name: "root",
      kind: "root",
      deps: [],
      config: "cfg",
      action: async () => "should not be called",
    });
    g.add({
      name: "child",
      kind: "child",
      deps: ["root"],
      config: "cfg",
      action: async () => "should not be called",
    });

    const mockRunner: NodeRunner = async (node, _inputs) => {
      calls.push(node.name);
      return `result:${node.name}`;
    };

    const results = await g.execute(mockRunner);
    expect(calls).toEqual(["root", "child"]);
    const child = results.find((r) => r.name === "child")!;
    expect(child.status === "done" && child.result).toBe("result:child");
  });

  describe("progress events", () => {
    test("emits start+done for dirty nodes", async () => {
      const cache = new MemCache();
      const g = new Graph(cache);
      g.add({ name: "a", kind: "root", deps: [], config: "1", action: async () => "a" });
      g.add({ name: "b", kind: "child", deps: ["a"], config: "2", action: async () => "b" });

      const events: ProgressEvent[] = [];
      await g.execute(localRunner, { maxParallelism: 1, onProgress: (e) => events.push(e) });

      expect(events).toEqual([
        { node: "a", kind: "root", status: "start" },
        { node: "a", kind: "root", status: "done", elapsed: expect.any(Number) },
        { node: "b", kind: "child", status: "start" },
        { node: "b", kind: "child", status: "done", elapsed: expect.any(Number) },
      ]);
      for (const e of events) {
        if (e.status === "done") expect(e.elapsed).toBeGreaterThanOrEqual(0);
      }
    });

    test("emits cached for cached nodes", async () => {
      const cache = new MemCache();
      const g1 = new Graph(cache);
      g1.add({ name: "a", kind: "root", deps: [], config: "1", action: async () => "a" });
      g1.add({ name: "b", kind: "child", deps: ["a"], config: "2", action: async () => "b" });
      await g1.execute();

      const g2 = new Graph(cache);
      g2.add({ name: "a", kind: "root", deps: [], config: "1", action: async () => "a" });
      g2.add({ name: "b", kind: "child", deps: ["a"], config: "2", action: async () => "b" });
      const events: ProgressEvent[] = [];
      await g2.execute(localRunner, { onProgress: (e) => events.push(e) });

      expect(events).toEqual([
        { node: "a", kind: "root", status: "cached" },
        { node: "b", kind: "child", status: "cached" },
      ]);
    });

    test("emits start+fail on error with error message and elapsed", async () => {
      const cache = new MemCache();
      const g = new Graph(cache);
      g.add({
        name: "bad",
        kind: "task",
        deps: [],
        config: "1",
        action: async () => {
          throw new Error("boom");
        },
      });

      const events: ProgressEvent[] = [];
      await g.execute(localRunner, { onProgress: (e) => events.push(e) });

      expect(events).toEqual([
        { node: "bad", kind: "task", status: "start" },
        { node: "bad", kind: "task", status: "fail", error: "boom", elapsed: expect.any(Number) },
      ]);
      const fail = events[1]!;
      if (fail.status === "fail") expect(fail.elapsed).toBeGreaterThanOrEqual(0);
    });

    test("emits dep-failed for dependency-failure skips", async () => {
      const cache = new MemCache();
      const g = new Graph(cache);
      g.add({
        name: "a",
        kind: "root",
        deps: [],
        config: "1",
        action: async () => {
          throw new Error("boom");
        },
      });
      g.add({ name: "b", kind: "child", deps: ["a"], config: "2", action: async () => "b" });

      const events: ProgressEvent[] = [];
      await g.execute(localRunner, { onProgress: (e) => events.push(e) });

      expect(events).toEqual([
        { node: "a", kind: "root", status: "start" },
        { node: "a", kind: "root", status: "fail", error: "boom", elapsed: expect.any(Number) },
        { node: "b", kind: "child", status: "dep-failed", error: "dependency a failed" },
      ]);
    });
  });
});
