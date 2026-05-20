import type { Command } from "commander";

import { getConfig } from "@/config";
import { sync } from "@/pipeline/execute";
import { buildPipelineGraph } from "@/pipeline/graph-builder";
import { publish } from "@/pipeline/publish";
import { createR2Cache } from "@/ports/r2-cache";
import { createRealPorts } from "@/ports/real";
import { FsCache, TieredCache, throttledScheduler } from "@podpiper/dagraph";

import { createProgressRenderer, renderAnalysisSummary, renderFinalSummary } from "../sync/render";

export function registerReprocess(program: Command) {
  program
    .command("reprocess")
    .description("Re-run the pipeline for one episode and overwrite its published files")
    .argument("<channel>", "Channel name (e.g. heidi, asianometry)")
    .argument("<videoId>", "YouTube video ID")
    .option("-c, --cookies <path>", "Path to Netscape-format cookie file for yt-dlp")
    .option("-p, --parallel <n>", "Max parallelism", (v: string) => parseInt(v), 4)
    .action(
      async (
        channel: string,
        videoId: string,
        opts: { cookies?: string; parallel: number },
      ) => {
        const config = getConfig(channel);
        const ports = createRealPorts({ ...opts, force: true });

        const casBaseDir = config.casBaseDir;
        const localCache = new FsCache(casBaseDir, ports.fs);
        const r2Cache = createR2Cache({
          storage: ports.storage,
          fs: ports.fs,
          bucket: config.storage.bucket,
          casBaseDir,
        });
        const cache = new TieredCache({ local: localCache, remote: r2Cache });
        const videos = [{ id: videoId, uploadDate: "", title: "" }];
        const { graph, refs } = buildPipelineGraph(videos, ports, config);

        const analysis = graph.analyze();
        renderAnalysisSummary(analysis);

        const executionCtx = { cache, fs: ports.fs, casBaseDir };
        const progress = createProgressRenderer(analysis, opts.parallel);
        const syncResult = await sync(graph, refs, ports.fs, executionCtx, {
          scheduler: throttledScheduler({
            maxParallelism: opts.parallel,
            concurrencyLimits: { whisper: 1 },
          }),
          onEvent: progress.onEvent,
          force: true,
        });
        progress.finish();
        renderFinalSummary(syncResult.results);

        console.log(`Publishing (overwriting existing files for ${videoId})...`);
        await publish(syncResult, config, ports.fs, ports.storage, ports.clock.now, { force: true });
        console.log("Done.");
      },
    );
}
