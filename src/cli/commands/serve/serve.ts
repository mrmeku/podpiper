import type { Command } from "commander";
import { HatchetClient } from "@hatchet-dev/typescript-sdk/v1";

import { channels, getConfig } from "@/config";
import { videoPipelineTopology } from "@/pipeline/graph-builder";
import { createRealPorts } from "@/ports/real";
import { toHatchetVideoWorkflow } from "./adapter";
import { registerChannelWorkflow } from "./channel-workflow";
import { LocalCache } from "@podpiper/dag/cache";
import type { CacheEntry } from "@podpiper/dag/types";

export function registerServe(program: Command) {
  program
    .command("serve")
    .description("Run as a Hatchet worker with scheduled syncs")
    .option("-s, --slots <n>", "Max concurrent tasks", (v: string) => parseInt(v), 4)
    .action(async (opts: { slots: number }) => {
      const hatchet = HatchetClient.init();
      const ports = createRealPorts();
      const workflows = [];

      for (const [name, def] of Object.entries(channels)) {
        const config = getConfig(name);
        const cachePath = `${config.outputDir}/cache.json`;
        let initial: Record<string, CacheEntry> = {};
        try {
          initial = await ports.fs.readJson(cachePath);
        } catch {}
        const cache = new LocalCache(initial, (data) => ports.fs.writeText(cachePath, data));
        const executionCtx = { cache, hashFile: ports.fs.hashFile };

        const topology = videoPipelineTopology(ports, config);
        const videoPipeline = toHatchetVideoWorkflow(
          hatchet,
          `${name}-video`,
          topology,
          ports,
          config,
          executionCtx,
        );
        const channelWorkflow = registerChannelWorkflow(
          hatchet,
          name,
          config,
          ports,
          videoPipeline,
          def.schedule,
        );
        workflows.push(videoPipeline, channelWorkflow);
      }

      const worker = await hatchet.worker("podpiper", {
        workflows,
        slots: opts.slots,
      });
      await worker.start();
    });
}
