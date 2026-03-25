import { sha256 } from "js-sha256";
import type { Outputs } from "./graph";
import type { CacheEntry } from "./cache";

/** Flatten an Outputs value (string, array, or record) into a flat list of file paths. */
export function collectPaths(outputs: Outputs): string[] {
  if (typeof outputs === "string") return [outputs];
  if (Array.isArray(outputs)) return outputs;
  return Object.values(outputs).flatMap((v) => (Array.isArray(v) ? v : [v]));
}

export type HashFileFn = (path: string) => Promise<string>;

/**
 * Compute the action key for a node: SHA256(name + config + sorted dep content hashes). This is
 * the cache key — identical inputs always produce the same key.
 */
export function computeActionKey(
  node: { name: string; config: string; deps: string[] },
  depHashes: Map<string, string>,
): string {
  const h = sha256.create();
  h.update(node.name);
  h.update(node.config);
  const sorted = [...node.deps].sort();
  for (const dep of sorted) {
    h.update(dep);
    const depHash = depHashes.get(dep);
    if (depHash === undefined) throw new Error(`BUG: missing content hash for dep "${dep}"`);
    h.update(depHash);
  }
  return h.hex();
}

/**
 * Compute a content hash over a node's output files. Used after execution to detect whether
 * outputs actually changed (early cutoff) and to store in the cache for downstream dep hashing.
 */
export async function hashOutputFiles(
  outputs: Outputs,
  hashFile: HashFileFn,
): Promise<string> {
  const paths = collectPaths(outputs).sort();
  const h = sha256.create();
  h.update(String(paths.length));
  for (const p of paths) h.update(await hashFile(p));
  return h.hex();
}

/**
 * Check that a cache entry's output files still exist and match their recorded content hash.
 * Returns false if any file is missing or corrupted. Called before accepting a cache hit.
 */
export async function verifyOutputs(entry: CacheEntry, hashFile: HashFileFn): Promise<boolean> {
  try {
    const currentHash = await hashOutputFiles(entry.outputs, hashFile);
    return currentHash === entry.contentHash;
  } catch {
    return false;
  }
}
