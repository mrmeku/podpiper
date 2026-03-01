import { $ } from "bun";

import type { Llm } from "./types";

export function createRealLlm(model: string): Llm {
  return {
    call: async (prompt) => {
      const output = await $`claude -p ${prompt} --model ${model} --output-format text`
        .quiet()
        .text();
      return output.trim();
    },
  };
}
