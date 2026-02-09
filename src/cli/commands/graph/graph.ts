import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Command } from "commander";

import { generateMermaid } from "./mermaid";
import { getConfig } from "@/config";
import { buildPipelineGraph } from "@/pipeline/graph-builder";
import { createStubPorts } from "@/ports/stub";
import type { VideoInfo } from "@/types";
import { MemCache } from "@podpiper/dag/cache";

export function registerGraph(program: Command) {
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

      const { graph } = buildPipelineGraph(new MemCache(), videos, createStubPorts(), config);
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
}
