import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { Cache, Flushable } from "./types";

export class MemCache implements Cache {
  private results = new Map<string, string>();
  get(hash: string): [string, boolean] {
    const r = this.results.get(hash);
    return r !== undefined ? [r, true] : ["", false];
  }
  put(hash: string, result: string): void {
    this.results.set(hash, result);
  }
}

export class LocalCache implements Cache, Flushable {
  private results: Record<string, string>;
  constructor(private path: string) {
    try {
      this.results = JSON.parse(readFileSync(path, "utf-8")) as Record<string, string>;
    } catch {
      this.results = {};
    }
  }
  get(hash: string): [string, boolean] {
    const r = this.results[hash];
    return r !== undefined ? [r, true] : ["", false];
  }
  put(hash: string, result: string): void {
    this.results[hash] = result;
  }
  flush(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.results, null, 2));
  }
}

export class TieredCache implements Cache {
  public local: Cache;
  public remote: Cache;
  constructor(opts: { local: Cache; remote: Cache }) {
    this.local = opts.local;
    this.remote = opts.remote;
  }
  get(hash: string): [string, boolean] {
    const [lr, lok] = this.local.get(hash);
    if (lok) return [lr, true];
    const [rr, rok] = this.remote.get(hash);
    if (rok) {
      this.local.put(hash, rr);
      return [rr, true];
    }
    return ["", false];
  }
  put(hash: string, result: string): void {
    this.local.put(hash, result);
    this.remote.put(hash, result);
  }
}
