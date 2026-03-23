import { $ } from "bun";

export async function exec(cmd: string[]): Promise<string> {
  const result = await $`${cmd}`.quiet().nothrow();
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    throw new Error(stderr || `Command failed with exit code ${result.exitCode}`);
  }
  return result.text();
}
