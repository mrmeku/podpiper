import { createHash } from "node:crypto";

import type { AnalyzedNode, Cache, Flushable, NodeCounts } from "./types";

export function computeHash(
  node: { name: string; config: string; deps: string[] },
  depHashes: Map<string, string>,
): string {
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

export function toCounts(nodes: AnalyzedNode[]): NodeCounts {
  const dirty = nodes.filter((n) => n.dirty).length;
  return { total: nodes.length, cached: nodes.length - dirty, dirty };
}

export function validateNoCycles(nodes: Map<string, { deps: string[] }>): string[] {
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const order: string[] = [];

  const visit = (name: string): void => {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error(`cycle detected at ${name}`);
    visiting.add(name);
    const node = nodes.get(name);
    if (!node) throw new Error(`unknown node: ${name}`);
    for (const dep of node.deps) visit(dep);
    visiting.delete(name);
    visited.add(name);
    order.push(name);
  };

  for (const name of nodes.keys()) visit(name);
  return order;
}
export function flushIfNeeded(cache: Cache): Promise<void> | void {
  if ("flush" in cache && typeof (cache as Flushable).flush === "function") {
    return (cache as Flushable).flush();
  }
}
