import type { Command } from "commander";

import { getConfig } from "@/config";
import { discoverVideos } from "@/pipeline/discovery";
import { sync } from "@/pipeline/execute";
import { buildPipelineGraph } from "@/pipeline/graph-builder";
import { publish } from "@/pipeline/publish";
import { createRealPorts } from "@/ports/real";
import { FsCache } from "@podpiper/dagraph";
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
    .option("-f, --force", "Skip cache and reupload everything")
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
        let videos = await discoverVideos(config.channelUrl, ports.ytdlp);
        console.log(`Found ${videos.length} videos`);

        if (opts.limit) {
          videos = videos.slice(0, opts.limit);
          console.log(`Processing ${videos.length} (limit=${opts.limit})`);
        }

        const casBaseDir = `${config.outputDir}/cas`;
        const cache = new FsCache(casBaseDir, ports.fs);
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
        });
        progress.finish();
        renderFinalSummary(syncResult.results);

        if (syncResult.results.some((r) => r.status === "done")) {
          console.log("Publishing...");
          await publish(syncResult, config, ports.fs, ports.storage);
          console.log("Done.");
        }
      },
    );
}
