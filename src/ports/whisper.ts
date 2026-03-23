import { basename, join } from "node:path";

import { exec } from "@/ports/exec";
import { jsonPath } from "@/typed-path";
import type { WhisperJson } from "@/types";

import type { Transcriber } from "./types";

export function createRealWhisper(modelPath: string): Transcriber {
  return {
    transcribe: async (audioPath, outputDir) => {
      const prefix = basename(audioPath, ".mp3");
      await exec([
        "whisper-cli",
        "-m",
        modelPath,
        "-oj",
        "-osrt",
        "-np",
        "-f",
        audioPath,
        "-of",
        join(outputDir, prefix),
      ]);
      return {
        srt: join(outputDir, `${prefix}.srt`),
        json: jsonPath<WhisperJson>(join(outputDir, `${prefix}.json`)),
      };
    },
  };
}
