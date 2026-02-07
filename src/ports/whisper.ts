import { basename, join } from "node:path";

import { $ } from "bun";

import type { Transcriber } from "./types";

export function createRealWhisper(modelPath: string): Transcriber {
  return {
    transcribe: async (audioPath, outputDir) => {
      const prefix = basename(audioPath, ".mp3");
      await $`whisper-cli -m ${modelPath} -oj -osrt -np -f ${audioPath} -of ${join(outputDir, prefix)}`.quiet();
      return {
        srt: join(outputDir, `${prefix}.srt`),
        json: join(outputDir, `${prefix}.json`),
      };
    },
  };
}
