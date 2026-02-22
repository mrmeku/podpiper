import { readdir } from "node:fs/promises";

import { CLAUDE_MODEL, WHISPER_MODEL_PATH } from "@/config";

import { callClaude } from "./claude";
import { createRealFfmpeg } from "./ffmpeg";
import { downloadFromR2, listRemoteFiles, uploadFile } from "./s3";
import type { Ports } from "./types";
import { createRealWhisper } from "./whisper";
import { createRealYtdlp } from "./ytdlp";

export function createRealPorts(opts?: { force?: boolean; cookies?: boolean }): Ports {
  return {
    fs: {
      exists: async (path) => Bun.file(path).exists(),
      readText: async (path) => Bun.file(path).text(),
      readJson: async (path) => {
        try {
          return await Bun.file(path).json();
        } catch (e) {
          throw new Error(`Failed to parse JSON from ${path}`, { cause: e });
        }
      },
      readBinary: async (path) => new Uint8Array(await Bun.file(path).arrayBuffer()),
      hashFile: async (path) => {
        const hasher = new Bun.CryptoHasher("sha256");
        for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
        return hasher.digest("hex");
      },
      writeText: async (path, content) => {
        await Bun.write(path, content);
      },
      stat: async (path) => {
        const f = Bun.file(path);
        if (!(await f.exists())) return null;
        return { size: f.size };
      },
      readdir: async (path) => {
        const entries = await readdir(path, { withFileTypes: true });
        return entries.map((e) => ({
          name: e.name,
          isDirectory: () => e.isDirectory(),
        }));
      },
    },
    ytdlp: createRealYtdlp({ force: Boolean(opts?.force), cookies: Boolean(opts?.cookies) }),
    ffmpeg: createRealFfmpeg(),
    whisper: createRealWhisper(WHISPER_MODEL_PATH),
    claude: { call: (prompt) => callClaude(prompt, CLAUDE_MODEL) },
    storage: {
      uploadFile,
      getFile: downloadFromR2,
      listFiles: listRemoteFiles,
    },
  };
}
