import { describe, expect, test } from "bun:test";

import { createMemoryFs } from "@/ports/memory-fs";
import type { FileSystem } from "@/ports/types";
import { MemCache, TieredCache } from "./cache";
import { defineAction } from "./define-action";
import type { ExecAction } from "./exec-state";
import { execute } from "./execute";
import type { ExecutionContext } from "./execute";
import { Graph, localRunner } from "./graph";
import type { BaseParams, ExecResult, NodeRunner } from "./types";

async function write(fs: FileSystem, name: string, content: string): Promise<string> {
  await fs.writeText(name, content);
  return name;
}

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
        deps: Object.fromEntries(Object.entries(deps).map(([k, v]) => [k, { name: v }])),
      }
    : { kind };

function addItemNodes(g: Graph, id: string, fs: FileSystem): void {
  const n = (kind: string) => `${kind}:${id}`;
  g.add({
    name: n("fetch"),
    kind: "fetch",
    deps: [],
    config: id,
    params: p("fetch"),
    action: async () => write(fs, `${id}-fetch.json`, `{"id":"${id}"}`),
  });
  g.add({
    name: n("extract"),
    kind: "extract",
    deps: [n("fetch")],
    config: "extract-v1",
    params: p("extract", { fetch: n("fetch") }),
    action: async () => write(fs, `${id}-raw.bin`, `raw-${id}`),
  });
  g.add({
    name: n("parse"),
    kind: "parse",
    deps: [n("extract")],
    config: "parse-v1",
    params: p("parse", { extract: n("extract") }),
    action: async () => write(fs, `${id}-parsed.txt`, `Parsed ${id}`),
  });
  g.add({
    name: n("summarize"),
    kind: "summarize",
    deps: [n("parse")],
    config: "summarize-v2",
    params: p("summarize", { parse: n("parse") }),
    action: async () => write(fs, `${id}-summary.txt`, `Summary of ${id}`),
  });
  g.add({
    name: n("classify"),
    kind: "classify",
    deps: [n("parse")],
    config: "classify-v1",
    params: p("classify", { parse: n("parse") }),
    action: async () => write(fs, `${id}-classify.json`, `["tag_a","tag_b"]`),
  });
  g.add({
    name: n("resize"),
    kind: "resize",
    deps: [n("fetch")],
    config: "resize-v1",
    params: p("resize", { fetch: n("fetch") }),
    action: async () => write(fs, `${id}-thumb.jpg`, `thumb-${id}`),
  });
  g.add({
    name: n("entry"),
    kind: "entry",
    deps: [n("summarize"), n("classify"), n("extract"), n("resize")],
    config: "entry-v1",
    params: p("entry", {
      summarize: n("summarize"),
      classify: n("classify"),
      extract: n("extract"),
      resize: n("resize"),
    }),
    action: async () => write(fs, `${id}-entry.json`, `{"entry":"${id}"}`),
  });
}

function addAggregateNode(g: Graph, ids: string[], fs: FileSystem): void {
  const deps = ids.map((id) => `entry:${id}`);
  const depsRecord = Object.fromEntries(deps.map((d) => [d, d]));
  g.add({
    name: "aggregate",
    kind: "aggregate",
    deps,
    config: "aggregate-v1",
    params: p("aggregate", depsRecord),
    action: async () => write(fs, "aggregate.json", `[${ids.join(",")}]`),
  });
}

function buildGraph(ids: string[], fs: FileSystem): Graph {
  const g = new Graph();
  for (const id of ids) addItemNodes(g, id, fs);
  addAggregateNode(g, ids, fs);
  return g;
}

function ctx(cache: MemCache | TieredCache, fs: FileSystem): ExecutionContext {
  return { cache, hashFile: fs.hashFile };
}

describe("Graph", () => {
  test("incremental items", async () => {
    const fs = createMemoryFs();
    const cache = new MemCache();

    let results = await execute(buildGraph(["aaa", "bbb"], fs), ctx(cache, fs));
    let { exec, skip } = countExec(results);
    expect(skip).toBe(0);
    expect(exec).toBe(15);

    results = await execute(buildGraph(["aaa", "bbb"], fs), ctx(cache, fs));
    ({ exec, skip } = countExec(results));
    expect(exec).toBe(0);
    expect(skip).toBe(15);

    results = await execute(buildGraph(["aaa", "bbb", "ccc"], fs), ctx(cache, fs));
    ({ exec, skip } = countExec(results));
    expect(exec).toBe(8);
    expect(skip).toBe(14);
  });

  test("tiered cache", async () => {
    const fs = createMemoryFs();
    const remote = new MemCache();

    let results = await execute(buildGraph(["aaa"], fs), ctx(remote, fs));
    let { exec } = countExec(results);
    expect(exec).toBe(8);

    const local = new MemCache();
    const tiered = new TieredCache({ local, remote });
    results = await execute(buildGraph(["aaa"], fs), ctx(tiered, fs));
    ({ exec } = countExec(results));
    expect(exec).toBe(0);

    results = await execute(buildGraph(["aaa"], fs), ctx(local, fs));
    ({ exec } = countExec(results));
    expect(exec).toBe(0);
  });

  describe("kindTopology()", () => {
    test("extracts kind-level edges from concrete graph", () => {
      const fs = createMemoryFs();
      expect(buildGraph(["aaa"], fs).kindTopology()).toEqual([
        { kind: "fetch", depKinds: [] },
        { kind: "extract", depKinds: ["fetch"] },
        { kind: "parse", depKinds: ["extract"] },
        { kind: "summarize", depKinds: ["parse"] },
        { kind: "classify", depKinds: ["parse"] },
        { kind: "resize", depKinds: ["fetch"] },
        { kind: "entry", depKinds: ["summarize", "classify", "extract", "resize"] },
        { kind: "aggregate", depKinds: ["entry"] },
      ]);
    });

    test("multiple items produce same topology as single item", () => {
      const fs = createMemoryFs();
      const single = buildGraph(["aaa"], fs).kindTopology();
      const multi = buildGraph(["aaa", "bbb", "ccc"], fs).kindTopology();
      expect(multi).toEqual(single);
    });
  });

  describe("analyze()", () => {
    test("returns total count", () => {
      const fs = createMemoryFs();
      const { total } = buildGraph(["aaa", "bbb"], fs).analyze();
      expect(total).toBe(15);
    });

    test("byKind breakdown", () => {
      const fs = createMemoryFs();
      const { byKind } = buildGraph(["aaa", "bbb"], fs).analyze();
      expect(Object.fromEntries(byKind)).toEqual({
        fetch: 2,
        extract: 2,
        parse: 2,
        summarize: 2,
        classify: 2,
        resize: 2,
        entry: 2,
        aggregate: 1,
      });
    });

    test("nodes list", () => {
      const fs = createMemoryFs();
      const { nodes } = buildGraph(["aaa"], fs).analyze();
      expect(nodes.length).toBe(8);
      const fetchNode = nodes.find((n) => n.name === "fetch:aaa")!;
      expect(fetchNode.kind).toBe("fetch");
      expect(fetchNode.deps).toEqual([]);
    });
  });

  test("readiness: dependent starts as soon as its deps finish", async () => {
    const fs = createMemoryFs();
    const cache = new MemCache();
    const g = new Graph();
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
        return write(fs, "slow_root.txt", "a");
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
        return write(fs, "fast_root.txt", "b");
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
        return write(fs, "slow_child.txt", "c");
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
        return write(fs, "fast_child.txt", "d");
      },
    });

    await execute(g, ctx(cache, fs));
    expect(log).toEqual(["fast_root", "fast_child", "slow_root", "slow_child"]);
  });

  test("children of completed nodes run before queued siblings", async () => {
    const fs = createMemoryFs();
    const cache = new MemCache();
    const g = new Graph();
    const log: string[] = [];

    g.add({
      name: "first_root",
      kind: "root",
      deps: [],
      config: "r1",
      params: p("root"),
      action: async () => {
        log.push("first_root");
        return write(fs, "r1.txt", "r1");
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
        return write(fs, "r2.txt", "r2");
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
        return write(fs, "c1.txt", "c1");
      },
    });

    await execute(g, ctx(cache, fs), localRunner, { maxParallelism: 1 });
    expect(log).toEqual(["first_root", "child", "second_root"]);
  });

  test("config change rollback", async () => {
    const fs = createMemoryFs();
    const cache = new MemCache();
    let leafConfig = "leaf-v2";

    const makeGraph = () => {
      const g = new Graph();
      g.add({
        name: "fetch",
        kind: "fetch",
        deps: [],
        config: "fetch-v1",
        params: p("fetch"),
        action: async () => write(fs, "fetch.json", '{"id":"aaa"}'),
      });
      g.add({
        name: "extract",
        kind: "extract",
        deps: ["fetch"],
        config: "extract-v1",
        params: p("extract", { fetch: "fetch" }),
        action: async () => write(fs, "raw.bin", "raw"),
      });
      g.add({
        name: "parse",
        kind: "parse",
        deps: ["extract"],
        config: "parse-v1",
        params: p("parse", { extract: "extract" }),
        action: async () => write(fs, "parsed.txt", "parsed"),
      });
      g.add({
        name: "summarize",
        kind: "summarize",
        deps: ["parse"],
        config: leafConfig,
        params: p("summarize", { parse: "parse" }),
        action: async () => write(fs, "summary.txt", "summary"),
      });
      return g;
    };

    let results = await execute(makeGraph(), ctx(cache, fs));
    let { exec, skip } = countExec(results);
    expect(exec).toBe(4);
    expect(skip).toBe(0);

    leafConfig = "leaf-v3";
    results = await execute(makeGraph(), ctx(cache, fs));
    ({ exec, skip } = countExec(results));
    expect(exec).toBe(1);

    leafConfig = "leaf-v2";
    results = await execute(makeGraph(), ctx(cache, fs));
    ({ exec, skip } = countExec(results));
    expect(exec).toBe(0);
  });

  test("mock runner: executor calls runner instead of node.action", async () => {
    const fs = createMemoryFs();
    const cache = new MemCache();
    const g = new Graph();
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

    const mockRunner: NodeRunner = async (node) => {
      calls.push(node.name);
      return write(fs, `${node.name}.txt`, `result:${node.name}`);
    };

    const results = await execute(g, ctx(cache, fs), mockRunner);
    expect(calls).toEqual(["root", "child"]);
    const child = results.find((r) => r.name === "child")!;
    expect(child.status).toBe("done");
    if (child.status === "done") {
      expect(child.outputs).toContain("child.txt");
    }
  });

  test("failure in one branch does not affect independent branches", async () => {
    const fs = createMemoryFs();
    const cache = new MemCache();
    const g = new Graph();
    g.add({
      name: "good_root",
      kind: "root",
      deps: [],
      config: "1",
      params: p("root"),
      action: async () => write(fs, "good_root.txt", "ok"),
    });
    g.add({
      name: "good_child",
      kind: "child",
      deps: ["good_root"],
      config: "2",
      params: p("child", { good_root: "good_root" }),
      action: async () => write(fs, "good_child.txt", "ok"),
    });
    g.add({
      name: "bad_root",
      kind: "root",
      deps: [],
      config: "3",
      params: p("root"),
      action: async () => {
        throw new Error("boom");
      },
    });
    g.add({
      name: "bad_child",
      kind: "child",
      deps: ["bad_root"],
      config: "4",
      params: p("child", { bad_root: "bad_root" }),
      action: async () => "unreachable",
    });

    const results = await execute(g, ctx(cache, fs));
    const byName = Object.fromEntries(results.map((r) => [r.name, r.status]));
    expect(byName).toEqual({
      good_root: "done",
      good_child: "done",
      bad_root: "fail",
      bad_child: "dep-failed",
    });
  });

  test("dep-failure cascades through transitive dependencies", async () => {
    const fs = createMemoryFs();
    const cache = new MemCache();
    const g = new Graph();
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
      kind: "mid",
      deps: ["a"],
      config: "2",
      params: p("mid", { a: "a" }),
      action: async () => "unreachable",
    });
    g.add({
      name: "c",
      kind: "mid",
      deps: ["b"],
      config: "3",
      params: p("mid", { b: "b" }),
      action: async () => "unreachable",
    });
    g.add({
      name: "d",
      kind: "leaf",
      deps: ["c"],
      config: "4",
      params: p("leaf", { c: "c" }),
      action: async () => "unreachable",
    });

    const results = await execute(g, ctx(cache, fs));
    const byName = Object.fromEntries(results.map((r) => [r.name, r.status]));
    expect(byName).toEqual({
      a: "fail",
      b: "dep-failed",
      c: "dep-failed",
      d: "dep-failed",
    });
  });

  test("maxParallelism caps concurrent execution", async () => {
    const fs = createMemoryFs();
    const cache = new MemCache();
    const g = new Graph();
    let peak = 0;
    let inflight = 0;

    for (let i = 0; i < 6; i++) {
      g.add({
        name: `task_${i}`,
        kind: "task",
        deps: [],
        config: `${i}`,
        params: p("task"),
        action: async () => {
          inflight++;
          peak = Math.max(peak, inflight);
          await Bun.sleep(20);
          inflight--;
          return write(fs, `task_${i}.txt`, `${i}`);
        },
      });
    }

    const results = await execute(g, ctx(cache, fs), localRunner, { maxParallelism: 2 });
    expect(peak).toBe(2);
    expect(results.filter((r) => r.status === "done").length).toBe(6);
  });

  describe("early cutoff", () => {
    test("same output content skips downstream", async () => {
      const fs = createMemoryFs();
      const cache = new MemCache();
      let aConfig = "a-v1";

      const makeGraph = () => {
        const g = new Graph();
        g.add({
          name: "a",
          kind: "root",
          deps: [],
          config: aConfig,
          params: p("root"),
          action: async () => write(fs, "a.txt", "stable-content"),
        });
        g.add({
          name: "b",
          kind: "child",
          deps: ["a"],
          config: "b-v1",
          params: p("child", { a: "a" }),
          action: async () => write(fs, "b.txt", "b-content"),
        });
        return g;
      };

      let results = await execute(makeGraph(), ctx(cache, fs));
      expect(countExec(results)).toEqual({ exec: 2, skip: 0 });

      aConfig = "a-v2";
      results = await execute(makeGraph(), ctx(cache, fs));
      expect(countExec(results)).toEqual({ exec: 1, skip: 1 });
    });

    test("different output content re-executes downstream", async () => {
      const fs = createMemoryFs();
      const cache = new MemCache();
      let aConfig = "a-v1";
      let aContent = "content-v1";

      const makeGraph = () => {
        const g = new Graph();
        g.add({
          name: "a",
          kind: "root",
          deps: [],
          config: aConfig,
          params: p("root"),
          action: async () => write(fs, "a.txt", aContent),
        });
        g.add({
          name: "b",
          kind: "child",
          deps: ["a"],
          config: "b-v1",
          params: p("child", { a: "a" }),
          action: async () => write(fs, "b.txt", "b-content"),
        });
        return g;
      };

      let results = await execute(makeGraph(), ctx(cache, fs));
      expect(countExec(results)).toEqual({ exec: 2, skip: 0 });

      aConfig = "a-v2";
      aContent = "content-v2";
      results = await execute(makeGraph(), ctx(cache, fs));
      expect(countExec(results)).toEqual({ exec: 2, skip: 0 });
    });

    test("cutoff chain: A → B → C, only A runs if output unchanged", async () => {
      const fs = createMemoryFs();
      const cache = new MemCache();
      let aConfig = "a-v1";

      const makeGraph = () => {
        const g = new Graph();
        g.add({
          name: "a",
          kind: "root",
          deps: [],
          config: aConfig,
          params: p("root"),
          action: async () => write(fs, "a.txt", "stable"),
        });
        g.add({
          name: "b",
          kind: "mid",
          deps: ["a"],
          config: "b-v1",
          params: p("mid", { a: "a" }),
          action: async () => write(fs, "b.txt", "b-stable"),
        });
        g.add({
          name: "c",
          kind: "leaf",
          deps: ["b"],
          config: "c-v1",
          params: p("leaf", { b: "b" }),
          action: async () => write(fs, "c.txt", "c-stable"),
        });
        return g;
      };

      let results = await execute(makeGraph(), ctx(cache, fs));
      expect(countExec(results)).toEqual({ exec: 3, skip: 0 });

      aConfig = "a-v2";
      results = await execute(makeGraph(), ctx(cache, fs));
      expect(countExec(results)).toEqual({ exec: 1, skip: 2 });
    });
  });

  describe("progress events", () => {
    test("emits start+success for dirty nodes", async () => {
      const fs = createMemoryFs();
      const cache = new MemCache();
      const g = new Graph();
      g.add({
        name: "a",
        kind: "root",
        deps: [],
        config: "1",
        params: p("root"),
        action: async () => write(fs, "a.txt", "a"),
      });
      g.add({
        name: "b",
        kind: "child",
        deps: ["a"],
        config: "2",
        params: p("child", { a: "a" }),
        action: async () => write(fs, "b.txt", "b"),
      });

      const actions: ExecAction[] = [];
      await execute(g, ctx(cache, fs), localRunner, {
        maxParallelism: 1,
        onAction: (a) => actions.push(a),
      });

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
      const fs = createMemoryFs();
      const cache = new MemCache();
      const makeGraph = () => {
        const g = new Graph();
        g.add({
          name: "a",
          kind: "root",
          deps: [],
          config: "1",
          params: p("root"),
          action: async () => write(fs, "a.txt", "a"),
        });
        g.add({
          name: "b",
          kind: "child",
          deps: ["a"],
          config: "2",
          params: p("child", { a: "a" }),
          action: async () => write(fs, "b.txt", "b"),
        });
        return g;
      };

      await execute(makeGraph(), ctx(cache, fs));

      const actions: ExecAction[] = [];
      await execute(makeGraph(), ctx(cache, fs), localRunner, {
        onAction: (a) => actions.push(a),
      });

      const types = actions.map((a) => `${a.type}:${a.node.name}`);
      expect(types).toEqual(["cache-hit:a", "complete:a", "cache-hit:b", "complete:b"]);
    });

    test("emits start+failure on error with elapsed", async () => {
      const fs = createMemoryFs();
      const cache = new MemCache();
      const g = new Graph();
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
      await execute(g, ctx(cache, fs), localRunner, { onAction: (a) => actions.push(a) });

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
      const fs = createMemoryFs();
      const cache = new MemCache();
      const g = new Graph();
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
      await execute(g, ctx(cache, fs), localRunner, { onAction: (a) => actions.push(a) });

      const types = actions.map((a) => `${a.type}:${a.node.name}`);
      expect(types).toEqual(["start:a", "failure:a", "complete:a", "dep-failure:b", "complete:b"]);
      const depFail = actions.find((a) => a.type === "dep-failure")!;
      if (depFail.type === "dep-failure") {
        expect(depFail.error).toBeInstanceOf(Error);
        expect((depFail.error as Error).message).toBe("dependency a failed");
      }
    });
  });

  describe("verify outputs on cache hit", () => {
    test("deleted output causes re-execution", async () => {
      const files = new Map<string, string>();
      const hashFile = async (path: string) => {
        const data = files.get(path);
        if (data === undefined) throw new Error(`ENOENT: ${path}`);
        return new Bun.CryptoHasher("sha256").update(data).digest("hex");
      };
      const cache = new MemCache();
      const executionCtx: ExecutionContext = { cache, hashFile };
      const makeGraph = () => {
        const g = new Graph();
        g.add({
          name: "a",
          kind: "root",
          deps: [],
          config: "1",
          params: p("root"),
          action: async () => {
            files.set("a.txt", "content-a");
            return "a.txt";
          },
        });
        return g;
      };

      let results = await execute(makeGraph(), executionCtx);
      expect(countExec(results)).toEqual({ exec: 1, skip: 0 });

      results = await execute(makeGraph(), executionCtx);
      expect(countExec(results)).toEqual({ exec: 0, skip: 1 });

      files.delete("a.txt");
      results = await execute(makeGraph(), executionCtx);
      expect(countExec(results)).toEqual({ exec: 1, skip: 0 });
    });

    test("corrupted output causes re-execution", async () => {
      const fs = createMemoryFs();
      const cache = new MemCache();
      const makeGraph = () => {
        const g = new Graph();
        g.add({
          name: "a",
          kind: "root",
          deps: [],
          config: "1",
          params: p("root"),
          action: async () => write(fs, "a.txt", "original"),
        });
        return g;
      };

      await execute(makeGraph(), ctx(cache, fs));
      await fs.writeText("a.txt", "tampered");

      const results = await execute(makeGraph(), ctx(cache, fs));
      expect(countExec(results)).toEqual({ exec: 1, skip: 0 });
    });
  });

  describe("structured config via defineAction", () => {
    test("object config produces deterministic cache keys", async () => {
      const fs = createMemoryFs();
      const cache = new MemCache();

      const action = defineAction<null, BaseParams, string, { version: number; flag: boolean }>({
        name: (params) => params.kind,
        config: { version: 1, flag: true },
        action: (_ctx, _config) => async () => write(fs, "out.txt", "result"),
      });

      const g = new Graph();
      action.addNode(g, null, { kind: "test" });
      let results = await execute(g, ctx(cache, fs));
      expect(countExec(results)).toEqual({ exec: 1, skip: 0 });

      const g2 = new Graph();
      action.addNode(g2, null, { kind: "test" });
      results = await execute(g2, ctx(cache, fs));
      expect(countExec(results)).toEqual({ exec: 0, skip: 1 });
    });

    test("config object passed to action function", async () => {
      const fs = createMemoryFs();
      const cache = new MemCache();
      let receivedConfig: unknown;

      const action = defineAction<null, BaseParams, string, { model: string }>({
        name: (params) => params.kind,
        config: { model: "gpt-4" },
        action: (_ctx, config) => async () => {
          receivedConfig = config;
          return write(fs, "out.txt", "result");
        },
      });

      const g = new Graph();
      action.addNode(g, null, { kind: "test" });
      await execute(g, ctx(cache, fs));
      expect(receivedConfig).toEqual({ model: "gpt-4" });
    });

    test("config change invalidates cache", async () => {
      const fs = createMemoryFs();
      const cache = new MemCache();

      const makeAction = (version: number) =>
        defineAction<null, BaseParams, string, { version: number }>({
          name: (p) => p.kind,
          config: { version },
          action: (_ctx, _config) => async () => write(fs, "out.txt", "result"),
        });

      const g1 = new Graph();
      makeAction(1).addNode(g1, null, { kind: "test" });
      let results = await execute(g1, ctx(cache, fs));
      expect(countExec(results)).toEqual({ exec: 1, skip: 0 });

      const g2 = new Graph();
      makeAction(2).addNode(g2, null, { kind: "test" });
      results = await execute(g2, ctx(cache, fs));
      expect(countExec(results)).toEqual({ exec: 1, skip: 0 });
    });
  });
});
