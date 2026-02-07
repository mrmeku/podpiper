import { $ } from "bun";

export async function callClaude(prompt: string, model: string): Promise<string> {
  const output = await $`claude -p ${prompt} --model ${model} --output-format text`.quiet().text();
  return output.trim();
}
