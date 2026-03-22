import type { Command } from "commander";

import { createR2Cache } from "@/ports/r2-cache";
import { getConfig } from "@/config";
import { sync } from "@/pipeline/execute";
import { buildPipelineGraph } from "@/pipeline/graph-builder";
import { publish } from "@/pipeline/publish";
import { createRealPorts } from "@/ports/real";
import { FsCache, TieredCache } from "@podpiper/dagraph";
import { createProgressRenderer, renderAnalysisSummary, renderFinalSummary } from "./render";

export function registerSync(program: Command) {
  program
    .command("sync")
    .description("Discover, process, and publish new episodes")
    .argument("<channel>", "Channel name (e.g. heidi, asianometry)")
    .option("-n, --limit <n>", "Max videos to process", (v: string) => parseInt(v))
    .option("-p, --parallel <n>", "Max parallelism", (v: string) => parseInt(v), 4)
    .option(
      "--concurrency <limits...>",
      "Per-group concurrency limits (e.g. whisper=1)",
      (v: string, acc: Record<string, number>) => {
        const [key, val] = v.split("=") as [string, string];
        acc[key] = parseInt(val);
        return acc;
      },
      { whisper: 1 } as Record<string, number>,
    )
    .option("-c, --cookies", "Use browser cookies for yt-dlp")
    .option("-f, --force", "Skip DAG cache and re-execute all pipeline nodes")
    .option("-d, --dry-run", "Show plan and exit without executing")
    .action(
      async (
        channel: string,
        opts: {
          limit?: number;
          parallel: number;
          concurrency: Record<string, number>;
          cookies?: boolean;
          force?: boolean;
          dryRun?: boolean;
        },
      ) => {
        const config = getConfig(channel);
        const ports = createRealPorts(opts);

        console.log(`Discovering videos for ${channel}...`);
        let videos = await ports.ytdlp.fetchVideoList(config);
        console.log(`Found ${videos.length} videos`);

        if (opts.limit) {
          videos = videos.slice(0, opts.limit);
          console.log(`Processing ${videos.length} (limit=${opts.limit})`);
        }

        const casBaseDir = config.casBaseDir;
        const localCache = new FsCache(casBaseDir, ports.fs);
        const r2Cache = createR2Cache({
          storage: ports.storage,
          fs: ports.fs,
          bucket: config.storage.bucket,
          casBaseDir,
        });
        const cache = new TieredCache({ local: localCache, remote: r2Cache });
        const { graph, refs } = buildPipelineGraph(videos, ports, config);

        const analysis = graph.analyze();
        renderAnalysisSummary(analysis);
        if (opts.dryRun) return;

        const executionCtx = { cache, fs: ports.fs, casBaseDir };
        const progress = createProgressRenderer(analysis, opts.parallel);
        const syncResult = await sync(graph, refs, ports.fs, executionCtx, {
          maxParallelism: opts.parallel,
          concurrencyLimits: opts.concurrency,
          onAction: progress.onAction,
          force: opts.force || false,
        });
        progress.finish();
        renderFinalSummary(syncResult.results);

        console.log("Publishing...");
        await publish(syncResult, config, ports.fs, ports.storage, ports.clock.now);
        console.log("Done.");
      },
    );
}
