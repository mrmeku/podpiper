import { tmpdir } from "node:os";
import { join } from "node:path";

import { MultiBar, type SingleBar } from "cli-progress";
import pc from "picocolors";

import type { ExecAction } from "@/dag/exec-state";
import type { AnalysisResult, ExecResult, NodeCounts } from "@/dag/types";

type ProgressRenderer = { onAction: (action: ExecAction) => void; finish: () => void };

export function renderAnalysisSummary(analysis: AnalysisResult): void {
  const { totalCounts, byKind } = analysis;
  console.log(
    `\nPlanning: ${totalCounts.total} nodes, ${totalCounts.cached} cached, ${totalCounts.dirty} to execute\n`,
  );
  for (const [kind, counts] of byKind) {
    const label = kind.length > 20 ? kind.slice(0, 19) + "\u2026" : kind;
    const status = counts.dirty === 0 ? "cached" : `-- ${counts.dirty} to run`;
    console.log(`  ${label.padEnd(20)} ${counts.cached}/${counts.total} ${status}`);
  }
  console.log();
}

export function createProgressRenderer(
  analysis: AnalysisResult,
  maxParallelism?: number,
): ProgressRenderer {
  const dirtyKinds = [...analysis.byKind.entries()].filter(([, c]) => c.dirty > 0);
  if (dirtyKinds.length === 0) return { onAction: () => {}, finish: () => {} };

  const label = maxParallelism ? ` (parallelism: ${maxParallelism})` : "";
  console.log(`Executing${label}...`);
  if (!process.stdout.isTTY) return createTextRenderer();
  return createBarRenderer(dirtyKinds);
}

const BAR_SIZE = 30;

function formatBar(done: number, failed: number, running: number, total: number): string {
  if (total === 0) return pc.dim("\u2591".repeat(BAR_SIZE));
  let remaining = BAR_SIZE;
  const doneW = Math.min(Math.round((BAR_SIZE * done) / total), remaining);
  remaining -= doneW;
  const failW = Math.min(Math.round((BAR_SIZE * failed) / total), remaining);
  remaining -= failW;
  const activeW = Math.min(Math.round((BAR_SIZE * running) / total), remaining);
  remaining -= activeW;
  return (
    "\u2588".repeat(doneW) +
    pc.red("\u2588".repeat(failW)) +
    pc.cyan("\u2593".repeat(activeW)) +
    pc.dim("\u2591".repeat(remaining))
  );
}

function createBarRenderer(dirtyKinds: [string, NodeCounts][]): ProgressRenderer {
  const multibar = new MultiBar({
    format: (_, params, payload) => {
      const bar = formatBar(payload.done, payload.failed, payload.running, params.total);
      const label = payload.running > 0 ? pc.cyan(` [${payload.running} running]`) : "";
      return `  ${payload.kind} ${bar} ${params.value}/${params.total}${label}`;
    },
    barsize: BAR_SIZE,
    hideCursor: true,
    clearOnComplete: false,
  });
  const bars = new Map<string, SingleBar>();
  const done = new Map<string, number>();
  const failed = new Map<string, number>();
  const inflight = new Map<string, number>();
  for (const [kind, counts] of dirtyKinds) {
    bars.set(
      kind,
      multibar.create(counts.dirty, 0, { kind: kind.padEnd(16), done: 0, failed: 0, running: 0 }),
    );
    done.set(kind, 0);
    failed.set(kind, 0);
    inflight.set(kind, 0);
  }

  function update(kind: string) {
    const d = done.get(kind) ?? 0;
    const f = failed.get(kind) ?? 0;
    const r = inflight.get(kind) ?? 0;
    bars.get(kind)?.update(d + f, { done: d, failed: f, running: r });
  }

  return {
    onAction(action) {
      const k = action.node.kind;
      if (!bars.has(k)) return;
      switch (action.type) {
        case "start":
          inflight.set(k, (inflight.get(k) ?? 0) + 1);
          break;
        case "success":
          inflight.set(k, Math.max(0, (inflight.get(k) ?? 0) - 1));
          done.set(k, (done.get(k) ?? 0) + 1);
          break;
        case "failure": {
          inflight.set(k, Math.max(0, (inflight.get(k) ?? 0) - 1));
          failed.set(k, (failed.get(k) ?? 0) + 1);
          const msg = action.error instanceof Error ? action.error.message : String(action.error);
          multibar.log(`  ${pc.red(`FAIL ${action.node.name}: ${msg}`)}\n`);
          break;
        }
        case "dep-failure":
          failed.set(k, (failed.get(k) ?? 0) + 1);
          break;
        default:
          return;
      }
      update(k);
    },
    finish() {
      multibar.stop();
    },
  };
}

function createTextRenderer(): ProgressRenderer {
  return {
    onAction(action) {
      if (action.type === "success") {
        console.log(`  done ${action.node.name} (${action.elapsed}ms)`);
      } else if (action.type === "failure") {
        const msg = action.error instanceof Error ? action.error.message : String(action.error);
        console.log(pc.red(`  FAIL ${action.node.name}: ${msg}`));
      }
    },
    finish() {},
  };
}

export function renderFinalSummary(results: ExecResult[]): void {
  let exec = 0,
    cached = 0,
    failed = 0,
    depFailed = 0;
  for (const r of results) {
    if (r.status === "done") exec++;
    else if (r.status === "cached") cached++;
    else if (r.status === "fail") failed++;
    else depFailed++;
  }
  const parts = [`${exec} executed`, `${cached} cached`, `${failed} failed`];
  if (depFailed > 0) parts.push(`${depFailed} dep-failed`);
  console.log(`\nDone: ${parts.join(", ")}`);
  const failures = results.filter((r) => r.status === "fail");
  const MAX_INLINE = 10;
  for (const r of failures.slice(0, MAX_INLINE)) {
    if (r.status === "fail") console.log(pc.red(`  FAIL ${r.name}: ${r.error.message}`));
  }
  if (failures.length > MAX_INLINE) {
    const path = join(tmpdir(), `podpiper-errors-${Date.now()}.log`);
    const lines = failures.map((r) =>
      r.status === "fail" ? `FAIL ${r.name}: ${r.error.message}` : "",
    );
    Bun.write(path, lines.join("\n") + "\n");
    console.log(`  ... ${failures.length - MAX_INLINE} more errors written to ${path}`);
  }
}
