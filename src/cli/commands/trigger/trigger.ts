import { TASK_QUEUES } from "@/cli/commands/serve/task-config";
import { channels } from "@/config";
import { Client, Connection } from "@temporalio/client";
import type { Command } from "commander";

export function registerTrigger(program: Command) {
  program
    .command("trigger <channel>")
    .description("Trigger a channel sync workflow via Temporal")
    .option("--address <addr>", "Temporal server address", "localhost:7233")
    .action(async (channel: string, opts: { address: string }) => {
      if (!channels[channel]) {
        console.error(`Unknown channel: ${channel}`);
        console.error(`Available: ${Object.keys(channels).join(", ")}`);
        process.exit(1);
      }

      const connection = await Connection.connect({ address: opts.address });
      const client = new Client({ connection });

      const workflowId = `${channel}-manual-${Date.now()}`;
      await client.workflow.start("channelWorkflow", {
        workflowId,
        taskQueue: TASK_QUEUES.workflows,
        args: [{ channelName: channel }],
      });

      console.log(`Started workflow ${workflowId}`);
      console.log(`View: http://localhost:8233/namespaces/default/workflows/${workflowId}`);
    });
}
