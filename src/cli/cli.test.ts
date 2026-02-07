import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { $ } from "bun";

describe("graph command", () => {
  test("mermaid output", async () => {
    const out = join(tmpdir(), `dag-test-${Date.now()}.mmd`);
    await $`bun run src/cli/cli.ts graph heidi --limit 2 --output ${out}`.quiet();
    const mermaid = await Bun.file(out).text();
    expect(mermaid).toMatchSnapshot();
  });
});
