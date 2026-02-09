import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { LocalCache, MemCache, TieredCache } from "./cache";
import type { ExecAction } from "./exec-state";
import { Graph, localRunner } from "./graph";
import type { BaseParams, ExecResult, NodeRunner } from "./types";

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

const p = (kind: string, deps?: Record<string, string>): BaseParams =>
  deps
    ? {
        kind,
        deps: Object.fromEntries(
          Object.entries(deps).map(([k, v]) => [
            k,
            { name: v },
          ]),
        ),
      }
    : { kind };

function addVideoNodes(g: Graph, vid: string): void {
  const n = (kind: string) => `${kind}:${vid}`;
  g.add({
    name: n("video"),
    kind: "video",
    deps: [],
    config: vid,
    params: p("video"),
    action: async () => `{"id":"${vid}"}`,
  });
  g.add({
    name: n("audio"),
    kind: "audio",
    deps: [n("video")],
    config: "format=mp3,bitrate=192k",
    params: p("audio", { video: n("video") }),
    action: async () => `/data/audio/${vid}.mp3`,
  });
  g.add({
    name: n("transcript"),
    kind: "transcript",
    deps: [n("audio")],
    config: "model=whisper-large-v3",
    params: p("transcript", { audio: n("audio") }),
    action: async () => `Transcript of ${vid}`,
  });
  g.add({
    name: n("summary"),
    kind: "summary",
    deps: [n("transcript")],
    config: "prompt=v2,model=claude-sonnet",
    params: p("summary", { transcript: n("transcript") }),
    action: async () => `Summary of ${vid}`,
  });
  g.add({
    name: n("chapters"),
    kind: "chapters",
    deps: [n("transcript")],
    config: "prompt=v1,model=claude-sonnet",
    params: p("chapters", { transcript: n("transcript") }),
    action: async () => "00:00 Intro",
  });
  g.add({
    name: n("thumbnail"),
    kind: "thumbnail",
    deps: [n("video")],
    config: "style=podcast-v2",
    params: p("thumbnail", { video: n("video") }),
    action: async () => `/data/thumb/${vid}.png`,
  });
  g.add({
    name: n("rss_entry"),
    kind: "rss_entry",
    deps: [n("summary"), n("chapters"), n("audio"), n("thumbnail")],
    config: "feed=v1",
    params: p("rss_entry", {
      summary: n("summary"),
      chapters: n("chapters"),
      audio: n("audio"),
      thumbnail: n("thumbnail"),
    }),
    action: async () => `<item>${vid}</item>`,
  });
}

function addFeedNode(g: Graph, vids: string[]): void {
  const deps = vids.map((vid) => `rss_entry:${vid}`);
  const depsRecord = Object.fromEntries(deps.map((d) => [d, d]));
  g.add({
    name: "feed",
    kind: "feed",
    deps,
    config: "feed_format=rss2.0",
    params: p("feed", depsRecord),
    action: async (rawInputs) => {
      const entries = Object.values(rawInputs);
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

  describe("analyze()", () => {
    test("all dirty on fresh cache", () => {
      const cache = new MemCache();
      const { totalCounts } = buildGraph(cache, ["vid_aaa", "vid_bbb"]).analyze();
      expect(totalCounts).toEqual({ total: 15, cached: 0, dirty: 15 });
    });

    test("all cached after execute", async () => {
      const cache = new MemCache();
      await buildGraph(cache, ["vid_aaa", "vid_bbb"]).execute();
      const { totalCounts } = buildGraph(cache, ["vid_aaa", "vid_bbb"]).analyze();
      expect(totalCounts).toEqual({ total: 15, cached: 15, dirty: 0 });
    });

    test("incremental new video", async () => {
      const cache = new MemCache();
      await buildGraph(cache, ["vid_aaa", "vid_bbb"]).execute();
      const { totalCounts } = buildGraph(cache, ["vid_aaa", "vid_bbb", "vid_ccc"]).analyze();
      expect(totalCounts.cached).toBe(14);
      expect(totalCounts.dirty).toBe(8);
    });

    test("byKind breakdown", () => {
      const cache = new MemCache();
      const { byKind } = buildGraph(cache, ["vid_aaa", "vid_bbb"]).analyze();
      const toNodeCounts = (total: number) => ({
        total,
        cached: 0,
        dirty: total,
      });
      expect(Object.fromEntries(byKind)).toEqual({
        video: toNodeCounts(2),
        audio: toNodeCounts(2),
        transcript: toNodeCounts(2),
        summary: toNodeCounts(2),
        chapters: toNodeCounts(2),
        thumbnail: toNodeCounts(2),
        rss_entry: toNodeCounts(2),
        feed: toNodeCounts(1),
      });
    });

    test("analyze agrees with execute", async () => {
      const cache = new MemCache();
      await buildGraph(cache, ["vid_aaa"]).execute();
      const g = buildGraph(cache, ["vid_aaa", "vid_bbb"]);
      const { totalCounts } = g.analyze();
      const results = await g.execute();
      const { exec, skip } = countExec(results);
      expect(totalCounts.dirty).toBe(exec);
      expect(totalCounts.cached).toBe(skip);
    });

    test("analyze hashes match execute hashes per node", async () => {
      const cache = new MemCache();
      const g = buildGraph(cache, ["vid_aaa", "vid_bbb"]);
      const analyzeHashes = new Map(g.analyze().nodes.map((n) => [n.name, n.hash]));
      const results = await g.execute();
      const executeHashes = new Map(results.map((r) => [r.name, r.hash]));
      expect(Object.fromEntries(analyzeHashes)).toEqual(Object.fromEntries(executeHashes));
    });

    test("nodes contain per-node details", () => {
      const cache = new MemCache();
      const { nodes } = buildGraph(cache, ["vid_aaa"]).analyze();
      expect(nodes.length).toBe(8);
      const video = nodes.find((n) => n.name === "video:vid_aaa")!;
      expect(video.kind).toBe("video");
      expect(video.deps).toEqual([]);
      expect(video.dirty).toBe(true);
      expect(video.hash).toBeTypeOf("string");
      expect(video.cachedResult).toBeUndefined();
    });

    test("nodes reflect cache state", async () => {
      const cache = new MemCache();
      await buildGraph(cache, ["vid_aaa"]).execute();
      const { nodes } = buildGraph(cache, ["vid_aaa"]).analyze();
      const video = nodes.find((n) => n.name === "video:vid_aaa")!;
      expect(video.dirty).toBe(false);
      expect(video.cachedResult).toBe('{"id":"vid_aaa"}');
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
      params: p("root"),
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
      params: p("root"),
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
      params: p("child", { slow_root: "slow_root" }),
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
      params: p("child", { fast_root: "fast_root" }),
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
      params: p("root"),
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
      params: p("root"),
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
      params: p("child", { first_root: "first_root" }),
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
        params: p("video"),
        action: async () => `{"id":"${vid}"}`,
      });
      g.add({
        name: n("audio"),
        kind: "audio",
        deps: [n("video")],
        config: "mp3",
        params: p("audio", { video: n("video") }),
        action: async () => `/audio/${vid}`,
      });
      g.add({
        name: n("transcript"),
        kind: "transcript",
        deps: [n("audio")],
        config: "whisper-v3",
        params: p("transcript", { audio: n("audio") }),
        action: async () => "transcript",
      });
      g.add({
        name: n("summary"),
        kind: "summary",
        deps: [n("transcript")],
        config: summaryPrompt,
        params: p("summary", { transcript: n("transcript") }),
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
      params: p("root"),
      action: async () => "should not be called",
    });
    g.add({
      name: "child",
      kind: "child",
      deps: ["root"],
      config: "cfg",
      params: p("child", { root: "root" }),
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
    test("emits start+success for dirty nodes", async () => {
      const cache = new MemCache();
      const g = new Graph(cache);
      g.add({
        name: "a",
        kind: "root",
        deps: [],
        config: "1",
        params: p("root"),
        action: async () => "a",
      });
      g.add({
        name: "b",
        kind: "child",
        deps: ["a"],
        config: "2",
        params: p("child", { a: "a" }),
        action: async () => "b",
      });

      const actions: ExecAction[] = [];
      await g.execute(localRunner, { maxParallelism: 1, onAction: (a) => actions.push(a) });

      const types = actions.map((a) => `${a.type}:${a.node.name}`);
      expect(types).toEqual([
        "start:a",
        "success:a",
        "complete:a",
        "start:b",
        "success:b",
        "complete:b",
      ]);
      for (const a of actions) {
        if (a.type === "success") expect(a.elapsed).toBeGreaterThanOrEqual(0);
      }
    });

    test("emits cache-hit for cached nodes", async () => {
      const cache = new MemCache();
      const g1 = new Graph(cache);
      g1.add({
        name: "a",
        kind: "root",
        deps: [],
        config: "1",
        params: p("root"),
        action: async () => "a",
      });
      g1.add({
        name: "b",
        kind: "child",
        deps: ["a"],
        config: "2",
        params: p("child", { a: "a" }),
        action: async () => "b",
      });
      await g1.execute();

      const g2 = new Graph(cache);
      g2.add({
        name: "a",
        kind: "root",
        deps: [],
        config: "1",
        params: p("root"),
        action: async () => "a",
      });
      g2.add({
        name: "b",
        kind: "child",
        deps: ["a"],
        config: "2",
        params: p("child", { a: "a" }),
        action: async () => "b",
      });
      const actions: ExecAction[] = [];
      await g2.execute(localRunner, { onAction: (a) => actions.push(a) });

      const types = actions.map((a) => `${a.type}:${a.node.name}`);
      expect(types).toEqual([
        "cache-hit:a",
        "complete:a",
        "cache-hit:b",
        "complete:b",
      ]);
    });

    test("emits start+failure on error with elapsed", async () => {
      const cache = new MemCache();
      const g = new Graph(cache);
      g.add({
        name: "bad",
        kind: "task",
        deps: [],
        config: "1",
        params: p("task"),
        action: async () => {
          throw new Error("boom");
        },
      });

      const actions: ExecAction[] = [];
      await g.execute(localRunner, { onAction: (a) => actions.push(a) });

      const types = actions.map((a) => `${a.type}:${a.node.name}`);
      expect(types).toEqual(["start:bad", "failure:bad", "complete:bad"]);
      const fail = actions.find((a) => a.type === "failure")!;
      if (fail.type === "failure") {
        expect(fail.error).toBeInstanceOf(Error);
        expect((fail.error as Error).message).toBe("boom");
        expect(fail.elapsed).toBeGreaterThanOrEqual(0);
      }
    });

    test("emits dep-failure for dependency-failure skips", async () => {
      const cache = new MemCache();
      const g = new Graph(cache);
      g.add({
        name: "a",
        kind: "root",
        deps: [],
        config: "1",
        params: p("root"),
        action: async () => {
          throw new Error("boom");
        },
      });
      g.add({
        name: "b",
        kind: "child",
        deps: ["a"],
        config: "2",
        params: p("child", { a: "a" }),
        action: async () => "b",
      });

      const actions: ExecAction[] = [];
      await g.execute(localRunner, { onAction: (a) => actions.push(a) });

      const types = actions.map((a) => `${a.type}:${a.node.name}`);
      expect(types).toEqual([
        "start:a",
        "failure:a",
        "complete:a",
        "dep-failure:b",
        "complete:b",
      ]);
      const depFail = actions.find((a) => a.type === "dep-failure")!;
      if (depFail.type === "dep-failure") {
        expect(depFail.error).toBeInstanceOf(Error);
        expect((depFail.error as Error).message).toBe("dependency a failed");
      }
    });
  });
});
