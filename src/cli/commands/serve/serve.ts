import type { Command } from "commander";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";

import { channels, getConfig } from "@/config";
import { createRealPorts } from "@/ports/real";
import { createActivities } from "./activities";
import { webpackConfigHook, WORKFLOW_BUNDLER_IGNORE_MODULES } from "./bundler-config";
import { TASK_QUEUES } from "./task-config";
import { FsCache } from "@podpiper/dagraph";

const DEFAULT_SCHEDULE = "0 */6 * * *"; // every 6 hours

export function registerServe(program: Command) {
  program
    .command("serve")
    .description("Run as a Temporal worker with scheduled syncs")
    .option("--address <addr>", "Temporal server address", "localhost:7233")
    .action(async (opts: { address: string }) => {
      const nativeConnection = await NativeConnection.connect({ address: opts.address });
      const clientConnection = await Connection.connect({ address: opts.address });
      const client = new Client({ connection: clientConnection });
      const ports = createRealPorts();

      // Collect activities from all channels
      const allActivities: Record<string, (...args: unknown[]) => unknown> = {};
      const channelConfigs: { name: string; schedule?: string }[] = [];

      for (const [name] of Object.entries(channels)) {
        const config = getConfig(name);
        const cache = new FsCache(config.casBaseDir, ports.fs);
        const executionCtx = { cache, fs: ports.fs, casBaseDir: config.casBaseDir };
        const activities = createActivities(ports, config, executionCtx);

        for (const [key, fn] of Object.entries(activities)) {
          allActivities[key] = fn;
        }

        channelConfigs.push({ name, schedule: DEFAULT_SCHEDULE });
      }

      // Workflow worker (V8 sandbox, no activities)
      const workflowWorker = await Worker.create({
        connection: nativeConnection,
        taskQueue: TASK_QUEUES.workflows,
        workflowsPath: new URL("./workflows.ts", import.meta.url).pathname,
        bundlerOptions: { webpackConfigHook, ignoreModules: WORKFLOW_BUNDLER_IGNORE_MODULES },
      });

      // Default activity worker
      const defaultWorker = await Worker.create({
        connection: nativeConnection,
        taskQueue: TASK_QUEUES.default,
        activities: allActivities,
        maxConcurrentActivityTaskExecutions: 10,
      });

      // Whisper worker (1 GPU slot)
      const whisperWorker = await Worker.create({
        connection: nativeConnection,
        taskQueue: TASK_QUEUES.whisper,
        activities: { processVideoNode: allActivities.processVideoNode },
        maxConcurrentActivityTaskExecutions: 1,
      });

      // Claude worker (rate-limited)
      const claudeWorker = await Worker.create({
        connection: nativeConnection,
        taskQueue: TASK_QUEUES.claude,
        activities: { processVideoNode: allActivities.processVideoNode },
        maxConcurrentActivityTaskExecutions: 5,
      });

      // Schedule cron workflows for each channel
      for (const ch of channelConfigs) {
        if (!ch.schedule) continue;
        const scheduleId = `${ch.name}-sync`;
        try {
          try {
            const handle = client.schedule.getHandle(scheduleId);
            await handle.delete();
          } catch {
            // Schedule doesn't exist yet
          }
          await client.schedule.create({
            scheduleId,
            spec: { cronExpressions: [ch.schedule] },
            action: {
              type: "startWorkflow",
              workflowType: "channelWorkflow",
              taskQueue: TASK_QUEUES.workflows,
              args: [{ channelName: ch.name }],
            },
          });
          console.log(`Scheduled ${scheduleId} with cron: ${ch.schedule}`);
        } catch (e) {
          console.error(`Failed to create schedule ${scheduleId}:`, e);
        }
      }

      console.log("Starting Temporal workers...");
      await Promise.all([
        workflowWorker.run(),
        defaultWorker.run(),
        whisperWorker.run(),
        claudeWorker.run(),
      ]);
    });
}
