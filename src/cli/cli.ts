#!/usr/bin/env bun
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";

import { createProgressRenderer, renderAnalysisSummary, renderFinalSummary } from "./render";
import { getConfig } from "@/config";
import { LocalCache, MemCache } from "@/dag/cache";
import { Graph } from "@/dag/graph";
import { generateMermaid } from "@/graph/mermaid";
import { checkMissing } from "@/pipeline/check";
import { discoverVideos } from "@/pipeline/discovery";
import { buildPipelineGraph } from "@/pipeline/graph-builder";
import { publish } from "@/pipeline/publish";
import { sync } from "@/pipeline/sync";
import { createRealPorts } from "@/ports/real";
import { createStubPorts } from "@/ports/stub";
import type { VideoInfo } from "@/types";

const program = new Command();

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

      const cache = opts.force ? new MemCache() : new LocalCache(`${config.outputDir}/cache.json`);
      const graph = new Graph(cache);
      const refs = buildPipelineGraph(graph, videos, ports, config);

      const analysis = graph.analyze();
      renderAnalysisSummary(analysis);
      if (opts.dryRun) return;

      const progress = createProgressRenderer(analysis, opts.parallel);
      const syncResult = await sync(graph, refs, {
        maxParallelism: opts.parallel,
        onProgress: progress.onProgress,
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

program
  .command("check")
  .description("Show videos not in feed (dry run)")
  .argument("<channel>", "Channel name")
  .action(async (channel: string) => {
    const config = getConfig(channel);
    const ports = createRealPorts();

    const videos = await discoverVideos(config.channelUrl, ports.ytdlp);
    const missing = await checkMissing(videos, config, ports.storage);
    console.log(`${missing.length} videos not in feed:`);
    for (const v of missing) {
      console.log(`  ${v.uploadDate} ${v.id} ${v.title}`);
    }
  });

program
  .command("graph")
  .description("Visualize the DAG for a channel")
  .argument("<channel>", "Channel name")
  .option("-n, --limit <n>", "Number of dummy videos", (v: string) => parseInt(v), 2)
  .option("-o, --output <path>", "Write mermaid to file instead of opening browser")
  .action(async (channel: string, opts: { limit: number; output?: string }) => {
    const config = getConfig(channel);
    const videos: VideoInfo[] = Array.from({ length: opts.limit }, (_, i) => ({
      id: `vid_${String.fromCharCode(97 + i).repeat(3)}`,
      uploadDate: "20240101",
      title: `Video ${i + 1}`,
    }));
    const graph = new Graph(new MemCache());
    buildPipelineGraph(graph, videos, createStubPorts(), config);
    const mermaid = generateMermaid(graph);

    if (opts.output) {
      await Bun.write(opts.output, mermaid);
      console.log(opts.output);
    } else {
      const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>DAG: ${channel}</title></head>
<body><pre class="mermaid">${mermaid}</pre>
<script type="module">import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";</script>
</body></html>`;
      const path = join(tmpdir(), `dag-${channel}.html`);
      await Bun.write(path, html);
      Bun.spawn([`open`, path]);
      console.log(path);
    }
  });

program.parse();
