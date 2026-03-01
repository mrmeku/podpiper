import type { CacheEntry, Outputs } from "./types";

export type HashFileFn = (path: string) => Promise<string>;

export function jsonParse<T = unknown>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    const preview = raw.length > 200 ? raw.slice(0, 200) + "…" : raw;
    throw new Error(`JSON parse failed (${label}): ${(e as Error).message}\nRaw value: ${preview}`);
  }
}

export function computeHash(
  node: { name: string; config: string; deps: string[] },
  depHashes: Map<string, string>,
): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(node.name);
  h.update(node.config);
  const sorted = [...node.deps].sort();
  for (const dep of sorted) {
    h.update(dep);
    const depHash = depHashes.get(dep);
    if (depHash === undefined) throw new Error(`BUG: missing content hash for dep "${dep}"`);
    h.update(depHash);
  }
  return h.digest("hex");
}

export function collectPaths(outputs: Outputs): string[] {
  if (typeof outputs === "string") return [outputs];
  if (Array.isArray(outputs)) return outputs;
  return Object.values(outputs).flatMap((v) => (Array.isArray(v) ? v : [v]));
}

export async function hashOutputFiles(
  outputs: Outputs,
  hashFile: HashFileFn,
): Promise<string> {
  const paths = collectPaths(outputs).sort();
  const h = new Bun.CryptoHasher("sha256");
  h.update(String(paths.length));
  for (const p of paths) h.update(await hashFile(p));
  return h.digest("hex");
}

export async function verifyOutputs(entry: CacheEntry, hashFile: HashFileFn): Promise<boolean> {
  try {
    const currentHash = await hashOutputFiles(entry.outputs, hashFile);
    return currentHash === entry.contentHash;
  } catch {
    return false;
  }
}

export function validateNoCycles(nodes: ReadonlyMap<string, { deps: string[] }>): string[] {
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

