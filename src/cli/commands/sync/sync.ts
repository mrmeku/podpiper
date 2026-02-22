import type { Command } from "commander";

import { getConfig } from "@/config";
import { discoverVideos } from "@/pipeline/discovery";
import { sync } from "@/pipeline/execute";
import { buildPipelineGraph } from "@/pipeline/graph-builder";
import { publish } from "@/pipeline/publish";
import { createRealPorts } from "@/ports/real";
import type { CacheEntry } from "@podpiper/dag/types";
import { LocalCache } from "@podpiper/dag/cache";
import { createProgressRenderer, renderAnalysisSummary, renderFinalSummary } from "./render";

export function registerSync(program: Command) {
  program
    .command("sync")
    .description("Discover, process, and publish new episodes")
    .argument("<channel>", "Channel name (e.g. heidi, asianometry)")
    .option("-n, --limit <n>", "Max videos to process", (v: string) => parseInt(v))
    .option("-p, --parallel <n>", "Max parallelism", (v: string) => parseInt(v), 4)
    .option("-c, --cookies", "Use browser cookies for yt-dlp")
    .option("-f, --force", "Skip cache and reupload everything")
    .option("-d, --dry-run", "Show plan and exit without executing")
    .action(
      async (
        channel: string,
        opts: {
          limit?: number;
          parallel: number;
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

        const cachePath = `${config.outputDir}/cache.json`;
        let initial: Record<string, CacheEntry> = {};
        if (!opts.force) {
          try {
            initial = await ports.fs.readJson(cachePath);
          } catch {}
        }
        const cache = new LocalCache(initial, (data) => ports.fs.writeText(cachePath, data));
        const { graph, refs } = buildPipelineGraph(cache, videos, ports, config);

        const analysis = graph.analyze();
        renderAnalysisSummary(analysis);
        if (opts.dryRun) return;

        const progress = createProgressRenderer(analysis, opts.parallel);
        const syncResult = await sync(graph, refs, ports.fs, {
          maxParallelism: opts.parallel,
          onAction: progress.onAction,
        });
        await cache.flush();
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
