import { createHash } from "node:crypto";
import { jsonParse } from "@podpiper/dagraph";
import type { FileSystem } from "./types";

export function createMemoryFs(initial?: Record<string, string | Uint8Array>): FileSystem {
  const files = new Map<string, string | Uint8Array>(initial ? Object.entries(initial) : []);

  return {
    exists: async (path) => files.has(path),
    readText: async (path) => {
      const data = files.get(path);
      if (data === undefined) throw new Error(`ENOENT: ${path}`);
      return typeof data === "string" ? data : new TextDecoder().decode(data);
    },
    readBinary: async (path) => {
      const data = files.get(path);
      if (data === undefined) throw new Error(`ENOENT: ${path}`);
      return typeof data === "string" ? new TextEncoder().encode(data) : data;
    },
    readJson: async <T = unknown>(path: string): Promise<T> => {
      const data = files.get(path);
      if (data === undefined) throw new Error(`ENOENT: ${path}`);
      const text = typeof data === "string" ? data : new TextDecoder().decode(data);
      return jsonParse<T>(text, `readJson(${path})`);
    },
    writeText: async (path, content) => {
      files.set(path, content);
    },
    writeBinary: async (path, data) => {
      files.set(path, data);
    },
    stat: async (path) => {
      const data = files.get(path);
      if (data === undefined) return null;
      const size = typeof data === "string" ? new TextEncoder().encode(data).length : data.length;
      return { size };
    },
    hashFile: async (path) => {
      const data = files.get(path);
      if (data === undefined) throw new Error(`ENOENT: ${path}`);
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
      return createHash("sha256").update(bytes).digest("hex");
    },
    ensureDir: async () => {},
    readdir: async (path) => {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const entries = new Set<string>();
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          const name = rest.split("/")[0];
          if (name) entries.add(name);
        }
      }
      return [...entries];
    },
  };
}
