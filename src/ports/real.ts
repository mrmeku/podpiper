import { createRealLlm } from "./claude";
import { createRealFfmpeg } from "./ffmpeg";
import { createRealFs } from "./fs";
import { createS3Storage } from "./s3";
import type { Ports } from "./types";
import { createRealWhisper } from "./whisper";
import { createRealYtdlp } from "./ytdlp";

const CLAUDE_MODEL = "sonnet";
const WHISPER_MODEL_PATH = `${process.env.HOME}/.whisper-models/ggml-large-v3-turbo.bin`;

export function createRealPorts(opts?: { force?: boolean; cookies?: string }): Ports {
  return {
    fs: createRealFs(),
    ytdlp: createRealYtdlp({ force: Boolean(opts?.force), ...(opts?.cookies ? { cookies: opts.cookies } : {}) }),
    ffmpeg: createRealFfmpeg(),
    whisper: createRealWhisper(WHISPER_MODEL_PATH),
    claude: createRealLlm(CLAUDE_MODEL),
    storage: createS3Storage(),
    clock: { now: () => new Date() },
  };
}
