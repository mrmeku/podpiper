import { basename, join } from "node:path";

import { $ } from "bun";

import { jsonPath } from "@/typed-path";
import type { WhisperJson } from "@/types";

import type { Transcriber } from "./types";

export function createRealWhisper(modelPath: string): Transcriber {
  return {
    transcribe: async (audioPath, outputDir) => {
      const prefix = basename(audioPath, ".mp3");
      const result =
        await $`whisper-cli -m ${modelPath} -oj -osrt -np -f ${audioPath} -of ${join(outputDir, prefix)}`
          .quiet()
          .nothrow();
      if (result.exitCode !== 0) {
        const stderr = result.stderr.toString().trim();
        throw new Error(stderr || `whisper-cli exited with code ${result.exitCode}`);
      }
      return {
        srt: join(outputDir, `${prefix}.srt`),
        json: jsonPath<WhisperJson>(join(outputDir, `${prefix}.json`)),
      };
    },
  };
}
