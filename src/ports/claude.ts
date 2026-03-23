import { exec } from "@/ports/exec";
import type { Llm } from "./types";

export function createRealLlm(model: string): Llm {
  return {
    call: async (prompt) => {
      const output = await exec([
        "claude",
        "-p",
        prompt,
        "--model",
        model,
        "--output-format",
        "text",
      ]);
      return output.trim();
    },
  };
}
