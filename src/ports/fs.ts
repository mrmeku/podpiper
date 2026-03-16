import { mkdir, readdir } from "node:fs/promises";

import type { FileSystem } from "./types";

export function createRealFs(): FileSystem {
  return {
    exists: async (path) => Bun.file(path).exists(),
    readText: async (path) => Bun.file(path).text(),
    readBinary: async (path) => new Uint8Array(await Bun.file(path).arrayBuffer()),
    readJson: async (path) => {
      try {
        return await Bun.file(path).json();
      } catch (e) {
        throw new Error(`Failed to parse JSON from ${path}`, { cause: e });
      }
    },
    hashFile: async (path) => {
      const hasher = new Bun.CryptoHasher("sha256");
      for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
      return hasher.digest("hex");
    },
    writeText: async (path, content) => {
      await Bun.write(path, content);
    },
    writeBinary: async (path, data) => {
      await Bun.write(path, data);
    },
    stat: async (path) => {
      const f = Bun.file(path);
      if (!(await f.exists())) return null;
      return { size: f.size };
    },
    ensureDir: async (path) => {
      await mkdir(path, { recursive: true });
    },
    readdir: async (path) => readdir(path),
  };
}
