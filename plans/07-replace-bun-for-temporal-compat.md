# 06 — Replace Bun with Node.js for Temporal Compatibility

## What

Replace all Bun-specific APIs with Node.js equivalents so the project can run under Node.js. Existing CLI commands (`sync`, `check`, `graph`) continue to work identically.

## Why

The Temporal TypeScript SDK is incompatible with Bun ([sdk-typescript#1334](https://github.com/temporalio/sdk-typescript/issues/1334)). This migration is a prerequisite for the Temporal integration (plan 07).

## Implementation

### Shell helper — new `src/shell.ts`

Replace `import { $ } from "bun"` with a thin wrapper around `node:child_process`:

```typescript
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function exec(cmd: string, args: string[]): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFile(cmd, args, {
      maxBuffer: 50 * 1024 * 1024,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (e: any) {
    if (e.code === "ENOENT") throw e; // command not found
    return {
      exitCode: e.status ?? 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}
```

### Port migrations

Each port file replaces `$\`cmd ${args}\``with`exec()`:

**`src/ports/ytdlp.ts`** — `$\`yt-dlp ${args}\`.quiet().text()`→`exec("yt-dlp", args)`then use`.stdout`; `.nothrow()`pattern → check`.exitCode`

**`src/ports/ffmpeg.ts`** — `$\`ffmpeg ${args}\`.quiet()`→`exec("ffmpeg", args)`

**`src/ports/whisper.ts`** — `$\`whisper-cli ${args}\`.quiet()`→`exec("whisper-cli", args)`

**`src/ports/claude.ts`** — `$\`claude ${args}\`.quiet().text()`→`exec("claude", args)`then use`.stdout`

### File I/O replacements

**`src/ports/real.ts`** — Replace `Bun.file()` / `Bun.write()` with `node:fs/promises`:

```typescript
import { readFile, writeFile, access, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

fs: {
  exists: async (path) => access(path).then(() => true, () => false),
  readText: async (path) => readFile(path, "utf-8"),
  readJson: async (path) => JSON.parse(await readFile(path, "utf-8")),
  readBinary: async (path) => new Uint8Array(await readFile(path)),
  writeText: async (path, content) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  },
  // stat and readdir already use node:fs — unchanged
}
```

**`src/ports/s3.ts`** — `Bun.file(filePath)` → `readFile(filePath)`

**`src/cli/cli.ts`** — `Bun.write()` → `writeFile()`, `Bun.spawn(["open", path])` → `spawn("open", [path])`

**`src/cli/render.ts`** — `Bun.write()` → `writeFileSync()`

### Hash replacements

**`src/pipeline/actions/chapters.ts`** and **`src/pipeline/actions/summary.ts`** — `Bun.hash(str).toString(36)` → `createHash("sha256").update(str).digest("hex").slice(0, 12)`

### Runtime and tooling

| Change            | From                                      | To                                      |
| ----------------- | ----------------------------------------- | --------------------------------------- |
| TypeScript runner | `bun run`                                 | `tsx` (add as dev dep)                  |
| Test runner       | `bun test`                                | `vitest` (add as dev dep)               |
| Test imports      | `import { test, expect } from "bun:test"` | `import { test, expect } from "vitest"` |
| Shebang           | `#!/usr/bin/env bun`                      | `#!/usr/bin/env tsx`                    |
| Dev dep           | `@types/bun`                              | Remove                                  |
| Sleep in tests    | `Bun.sleep(50)`                           | `new Promise(r => setTimeout(r, 50))`   |
| Typecheck         | `bunx tsgo`                               | `npx tsgo`                              |
| Path aliases      | Works in Bun natively                     | Works in tsx via tsconfig `paths`       |

## File Summary

### New Files

| File           | Purpose                                               |
| -------------- | ----------------------------------------------------- |
| `src/shell.ts` | `exec(cmd, args)` wrapper around `node:child_process` |

### Modified Files

| File                               | Change                                               |
| ---------------------------------- | ---------------------------------------------------- |
| `src/ports/ytdlp.ts`               | `exec()` instead of `$`                              |
| `src/ports/ffmpeg.ts`              | `exec()` instead of `$`                              |
| `src/ports/whisper.ts`             | `exec()` instead of `$`                              |
| `src/ports/claude.ts`              | `exec()` instead of `$`                              |
| `src/ports/real.ts`                | `node:fs/promises` instead of `Bun.file`/`Bun.write` |
| `src/ports/s3.ts`                  | `readFile` instead of `Bun.file`                     |
| `src/cli/cli.ts`                   | Replace `Bun.write`/`Bun.spawn`                      |
| `src/cli/render.ts`                | `writeFileSync` instead of `Bun.write`               |
| `src/pipeline/actions/chapters.ts` | `createHash` instead of `Bun.hash`                   |
| `src/pipeline/actions/summary.ts`  | `createHash` instead of `Bun.hash`                   |
| `package.json`                     | Add `tsx` + `vitest` deps, remove `@types/bun`       |
| `*.test.ts`                        | `vitest` imports instead of `bun:test`               |
