import type { FileSystem } from "./types";

export function createMemoryFs(
  initial?: Record<string, string | Uint8Array>,
): FileSystem {
  const files = new Map<string, string | Uint8Array>(
    initial ? Object.entries(initial) : [],
  );

  return {
    exists: async (path) => files.has(path),
    readText: async (path) => {
      const data = files.get(path);
      if (data === undefined) throw new Error(`ENOENT: ${path}`);
      return typeof data === "string" ? data : new TextDecoder().decode(data);
    },
    readJson: async <T = unknown>(path: string): Promise<T> => {
      const data = files.get(path);
      if (data === undefined) throw new Error(`ENOENT: ${path}`);
      const text =
        typeof data === "string" ? data : new TextDecoder().decode(data);
      return JSON.parse(text) as T;
    },
    readBinary: async (path) => {
      const data = files.get(path);
      if (data === undefined) throw new Error(`ENOENT: ${path}`);
      return typeof data === "string" ? new TextEncoder().encode(data) : data;
    },
    writeText: async (path, content) => {
      files.set(path, content);
    },
    stat: async (path) => {
      const data = files.get(path);
      if (data === undefined) return null;
      const size =
        typeof data === "string"
          ? new TextEncoder().encode(data).length
          : data.length;
      return { size };
    },
    readdir: async (dirPath) => {
      const normalizedDir = dirPath.endsWith("/") ? dirPath : dirPath + "/";
      const entries = new Map<string, boolean>();
      for (const key of files.keys()) {
        if (!key.startsWith(normalizedDir)) continue;
        const relative = key.slice(normalizedDir.length);
        const firstSegment = relative.split("/")[0]!;
        const isDir = relative.includes("/");
        const existing = entries.get(firstSegment);
        if (existing === undefined || isDir) {
          entries.set(firstSegment, isDir);
        }
      }
      return Array.from(entries.entries()).map(([name, isDir]) => ({
        name,
        isDirectory: () => isDir,
      }));
    },
  };
}
