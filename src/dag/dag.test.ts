import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { LocalCache, MemCache, TieredCache } from "./cache";
import { Graph } from "./graph";
import type { ExecResult } from "./types";

function countExec(results: ExecResult[]): { exec: number; skip: number } {
  let exec = 0;
  let skip = 0;
  for (const r of results) {
    if (r.error) continue;
    if (r.skipped) skip++;
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

function buildGraph(
  cache: MemCache | LocalCache | TieredCache,
  vids: string[],
): Graph {
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
    results = await buildGraph(cache, [
      "vid_aaa",
      "vid_bbb",
      "vid_ccc",
    ]).execute();
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
});
