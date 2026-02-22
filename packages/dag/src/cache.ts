import type { Cache, CacheEntry } from "./types";

export class MemCache implements Cache {
  private entries = new Map<string, CacheEntry>();
  async get(key: string): Promise<CacheEntry | undefined> {
    return this.entries.get(key);
  }
  async put(key: string, entry: CacheEntry): Promise<void> {
    this.entries.set(key, entry);
  }
}

export class LocalCache implements Cache {
  private entries: Record<string, CacheEntry>;
  constructor(
    initial: Record<string, CacheEntry>,
    private onFlush?: (data: string) => void | Promise<void>,
  ) {
    this.entries = initial;
  }
  async get(key: string): Promise<CacheEntry | undefined> {
    return this.entries[key];
  }
  async put(key: string, entry: CacheEntry): Promise<void> {
    this.entries[key] = entry;
  }
  async flush(): Promise<void> {
    await this.onFlush?.(JSON.stringify(this.entries, null, 2));
  }
}

export class TieredCache implements Cache {
  public local: Cache;
  public remote: Cache;
  constructor(opts: { local: Cache; remote: Cache }) {
    this.local = opts.local;
    this.remote = opts.remote;
  }
  async get(key: string): Promise<CacheEntry | undefined> {
    const local = await this.local.get(key);
    if (local) return local;
    const remote = await this.remote.get(key);
    if (remote) {
      await this.local.put(key, remote);
      return remote;
    }
    return undefined;
  }
  async put(key: string, entry: CacheEntry): Promise<void> {
    await this.local.put(key, entry);
    await this.remote.put(key, entry);
  }
}
