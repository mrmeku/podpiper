import type { Cache, CacheEntry, DagFs } from "./types";

export class FsCache implements Cache {
  constructor(
    private baseDir: string,
    private fs: DagFs,
  ) {}
  async get(key: string): Promise<CacheEntry | undefined> {
    try {
      const raw = await this.fs.readText(`${this.baseDir}/${key}/manifest.json`);
      return JSON.parse(raw) as CacheEntry;
    } catch {
      return undefined;
    }
  }
  async put(key: string, entry: CacheEntry): Promise<void> {
    await this.fs.writeText(`${this.baseDir}/${key}/manifest.json`, JSON.stringify(entry, null, 2));
  }
}

export class MemCache implements Cache {
  private entries = new Map<string, CacheEntry>();
  async get(key: string): Promise<CacheEntry | undefined> {
    return this.entries.get(key);
  }
  async put(key: string, entry: CacheEntry): Promise<void> {
    this.entries.set(key, entry);
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
