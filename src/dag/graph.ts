import { createHash } from "node:crypto";

import type {
  Cache,
  ExecResult,
  Flushable,
  Node,
  NodeCounts,
  PlanningResult,
} from "./types";

export let maxParallelism = 4;
export function setMaxParallelism(n: number): void {
  maxParallelism = n;
}

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

  private topoSort(): string[] {
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
    return this.nodes.entries().reduce<{
      hashes: Map<string, string>;
      totalCounts: NodeCounts;
      byKind: Map<string, NodeCounts>;
    }>(
      (acc, [name, node]) => {
        const depHashes = new Map(
          node.deps.map((d) => [d, acc.hashes.get(d) ?? ""]),
        );
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

  async execute(): Promise<ExecResult[]> {
    const order = this.topoSort();

    const hashes = new Map<string, string>();
    const results = new Map<string, string>();
    const execResults = new Map<string, ExecResult>();
    const failed = new Set<string>();

    const depth = new Map<string, number>();
    for (const name of order) {
      let d = 0;
      for (const dep of this.nodes.get(name)!.deps) {
        d = Math.max(d, (depth.get(dep) ?? 0) + 1);
      }
      depth.set(name, d);
    }
    let maxDepth = 0;
    for (const d of depth.values()) {
      if (d > maxDepth) maxDepth = d;
    }

    for (let d = 0; d <= maxDepth; d++) {
      const level = order.filter((name) => depth.get(name) === d);
      const semaphore = { count: 0 };
      const waiting: (() => void)[] = [];
      const acquire = (): Promise<void> => {
        if (semaphore.count < maxParallelism) {
          semaphore.count++;
          return Promise.resolve();
        }
        return new Promise<void>((resolve) => waiting.push(resolve));
      };
      const release = (): void => {
        const next = waiting.shift();
        if (next) {
          next();
        } else {
          semaphore.count--;
        }
      };

      await Promise.all(
        level.map(async (name) => {
          await acquire();
          try {
            const node = this.nodes.get(name)!;
            for (const dep of node.deps) {
              if (failed.has(dep)) {
                failed.add(name);
                execResults.set(name, {
                  name,
                  hash: "",
                  result: null,
                  skipped: false,
                  error: new Error(`skipped: dependency ${dep} failed`),
                });
                return;
              }
            }

            const depHashes = new Map<string, string>();
            for (const dep of node.deps)
              depHashes.set(dep, hashes.get(dep) ?? "");
            const hash = computeHash(node, depHashes);

            const [cachedResult, hit] = this.cache.get(hash);
            if (hit) {
              hashes.set(name, hash);
              results.set(name, cachedResult);
              execResults.set(name, {
                name,
                hash,
                result: cachedResult,
                skipped: true,
                error: null,
              });
              return;
            }

            const inputs: Record<string, string> = {};
            for (const dep of node.deps) inputs[dep] = results.get(dep) ?? "";

            try {
              const result = await node.action(inputs);
              hashes.set(name, hash);
              results.set(name, result);
              this.cache.put(hash, result);
              execResults.set(name, {
                name,
                hash,
                result,
                skipped: false,
                error: null,
              });
            } catch (e) {
              failed.add(name);
              execResults.set(name, {
                name,
                hash,
                result: null,
                skipped: false,
                error: e instanceof Error ? e : new Error(String(e)),
              });
            }
          } finally {
            release();
          }
        }),
      );
    }

    const isFlushable = (c: Cache): c is Cache & Flushable =>
      "flush" in c && typeof (c as Flushable).flush === "function";
    if (isFlushable(this.cache)) await this.cache.flush();

    return order
      .filter((name) => execResults.has(name))
      .map((name) => execResults.get(name)!);
  }
}
