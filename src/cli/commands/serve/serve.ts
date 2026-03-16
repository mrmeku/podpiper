import type { Command } from "commander";
import { HatchetClient } from "@hatchet-dev/typescript-sdk/v1";

import { channels, getConfig } from "@/config";
import { videoPipelineTopology } from "@/pipeline/graph-builder";
import { createRealPorts } from "@/ports/real";
import { toHatchetVideoWorkflow } from "./adapter";
import { registerChannelWorkflow } from "./channel-workflow";
import { FsCache } from "@podpiper/dagraph";

const schedules: Record<string, string> = {};

export function registerServe(program: Command) {
  program
    .command("serve")
    .description("Run as a Hatchet worker with scheduled syncs")
    .option("-s, --slots <n>", "Max concurrent tasks", (v: string) => parseInt(v), 4)
    .action(async (opts: { slots: number }) => {
      const hatchet = HatchetClient.init();
      const ports = createRealPorts();
      const workflows = [];

      for (const [name] of Object.entries(channels)) {
        const config = getConfig(name);
        const cache = new FsCache(config.casBaseDir, ports.fs);
        const executionCtx = { cache, fs: ports.fs, casBaseDir: config.casBaseDir };

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
          schedules[name],
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
