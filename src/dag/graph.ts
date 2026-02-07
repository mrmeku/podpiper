import { createHash } from "node:crypto";

import type {
  Cache,
  ExecResult,
  ExecuteOptions,
  Flushable,
  Node,
  NodeCounts,
  NodeRunner,
  PlanningResult,
  ProgressEvent,
} from "./types";

function computeHash(node: Node, depHashes: Map<string, string>): string {
  const h = createHash("sha256");
  h.update(node.name);
  h.update(node.config);
  const sorted = [...node.deps].sort();
  for (const dep of sorted) {
    h.update(dep);
    h.update(depHashes.get(dep) ?? "");
  }
  return h.digest("hex");
}

export const localRunner: NodeRunner = (node, inputs) => node.action(inputs);

export class Graph {
  private nodes = new Map<string, Node>();
  constructor(private cache: Cache) {}

  add(node: Node): void {
    this.nodes.set(node.name, node);
  }

  getNodes(): ReadonlyMap<string, Node> {
    return this.nodes;
  }

  nodeCount(): number {
    return this.nodes.size;
  }

  private validateNoCycles(): string[] {
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const order: string[] = [];

    const visit = (name: string): void => {
      if (visited.has(name)) return;
      if (visiting.has(name)) throw new Error(`cycle detected at ${name}`);
      visiting.add(name);
      const node = this.nodes.get(name);
      if (!node) throw new Error(`unknown node: ${name}`);
      for (const dep of node.deps) visit(dep);
      visiting.delete(name);
      visited.add(name);
      order.push(name);
    };

    for (const name of this.nodes.keys()) visit(name);
    return order;
  }

  plan(): PlanningResult {
    this.validateNoCycles();
    return this.nodes.entries().reduce<{
      hashes: Map<string, string>;
      totalCounts: NodeCounts;
      byKind: Map<string, NodeCounts>;
    }>(
      (acc, [name, node]) => {
        const depHashes = new Map(node.deps.map((d) => [d, acc.hashes.get(d) ?? ""]));
        const hash = computeHash(node, depHashes);
        acc.hashes.set(name, hash);

        const hit = this.cache.get(hash)[1];
        acc.totalCounts.total++;
        if (hit) acc.totalCounts.cached++;
        else acc.totalCounts.dirty++;

        let counts = acc.byKind.get(node.kind);
        if (!counts) {
          counts = { total: 0, cached: 0, dirty: 0 };
          acc.byKind.set(node.kind, counts);
        }
        counts.total++;
        if (hit) counts.cached++;
        else counts.dirty++;

        return acc;
      },
      {
        hashes: new Map(),
        totalCounts: { total: 0, cached: 0, dirty: 0 },
        byKind: new Map(),
      },
    );
  }

  async execute(runner: NodeRunner = localRunner, opts?: ExecuteOptions): Promise<ExecResult[]> {
    const { maxParallelism, onProgress } = opts ?? {};
    const emit = onProgress ? (e: ProgressEvent) => onProgress(e) : undefined;
    const hashes = new Map<string, string>();
    const results = new Map<string, string>();
    const execResults = new Map<string, ExecResult>();
    const failed = new Set<string>();

    // Build reverse dependency map
    const dependents = new Map<string, Node[]>();
    for (const node of this.nodes.values()) {
      for (const dep of node.deps) {
        let list = dependents.get(dep);
        if (!list) {
          list = [];
          dependents.set(dep, list);
        }
        list.push(node);
      }
    }

    const processNode = async (node: Node): Promise<void> => {
      const { name, kind } = node;

      for (const dep of node.deps) {
        if (failed.has(dep)) {
          failed.add(name);
          emit?.({ node: name, kind, status: "dep-failed", error: `dependency ${dep} failed` });
          execResults.set(name, {
            name,
            hash: "",
            status: "dep-failed",
            error: new Error(`dependency ${dep} failed`),
          });
          return;
        }
      }

      const depHashes = new Map<string, string>();
      for (const dep of node.deps) depHashes.set(dep, hashes.get(dep) ?? "");
      const hash = computeHash(node, depHashes);

      const [cachedResult, hit] = this.cache.get(hash);
      if (hit) {
        hashes.set(name, hash);
        results.set(name, cachedResult);
        emit?.({ node: name, kind, status: "cached" });
        execResults.set(name, { name, hash, status: "cached", result: cachedResult });
        return;
      }

      const inputs: Record<string, string> = {};
      for (const dep of node.deps) inputs[dep] = results.get(dep) ?? "";

      emit?.({ node: name, kind, status: "start" });
      const startTime = Date.now();
      try {
        const result = await runner(node, inputs);
        hashes.set(name, hash);
        results.set(name, result);
        this.cache.put(hash, result);
        emit?.({ node: name, kind, status: "done", elapsed: Date.now() - startTime });
        execResults.set(name, { name, hash, status: "done", result });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        emit?.({ node: name, kind, status: "fail", elapsed: Date.now() - startTime, error });
        failed.add(name);
        execResults.set(name, {
          name,
          hash,
          status: "fail",
          error: e instanceof Error ? e : new Error(String(e)),
        });
      }
    };

    // Seed ready queue with zero-dep nodes
    const ready: Node[] = [];
    const enqueued = new Set<string>();
    let inflight = 0;
    let wakeEventLoop: () => void = () => {};

    for (const node of this.nodes.values()) {
      if (node.deps.length === 0) {
        ready.push(node);
        enqueued.add(node.name);
      }
    }

    while (ready.length > 0 || inflight > 0) {
      while (ready.length > 0 && (maxParallelism == null || inflight < maxParallelism)) {
        const node = ready.shift()!;
        inflight++;
        processNode(node).then(() => {
          inflight--;
          for (const child of dependents.get(node.name) ?? []) {
            if (!enqueued.has(child.name) && child.deps.every((d) => execResults.has(d))) {
              ready.unshift(child);
              enqueued.add(child.name);
            }
          }
          wakeEventLoop();
        });
      }
      // Suspend the event loop until any inflight node completes and calls wakeEventLoop()
      await new Promise<void>((resolve) => {
        wakeEventLoop = resolve;
      });
    }

    const isFlushable = (c: Cache): c is Cache & Flushable =>
      "flush" in c && typeof (c as Flushable).flush === "function";
    if (isFlushable(this.cache)) await this.cache.flush();

    return [...execResults.values()];
  }
}
