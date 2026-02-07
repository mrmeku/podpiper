import { readdir, stat } from "node:fs/promises";

import { CLAUDE_MODEL, WHISPER_MODEL_PATH } from "@/config";

import { callClaude } from "./claude";
import { createRealFfmpeg } from "./ffmpeg";
import { downloadFromR2, listRemoteFiles, uploadFile } from "./s3";
import type { Ports } from "./types";
import { createRealWhisper } from "./whisper";
import { createRealYtdlp } from "./ytdlp";

export function createRealPorts(opts?: { force?: boolean }): Ports {
  return {
    fs: {
      exists: async (path) => Bun.file(path).exists(),
      readText: async (path) => Bun.file(path).text(),
      readJson: async (path) => Bun.file(path).json(),
      readBinary: async (path) =>
        new Uint8Array(await Bun.file(path).arrayBuffer()),
      writeText: async (path, content) => {
        await Bun.write(path, content);
      },
      stat: async (path) => {
        try {
          const s = await stat(path);
          return { size: s.size };
        } catch {
          return null;
        }
      },
      readdir: async (path) => {
        const entries = await readdir(path, { withFileTypes: true });
        return entries.map((e) => ({
          name: e.name,
          isDirectory: () => e.isDirectory(),
        }));
      },
    },
    ytdlp: createRealYtdlp({ force: Boolean(opts?.force) }),
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
