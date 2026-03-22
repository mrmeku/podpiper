#!/usr/bin/env bun
import { Command } from "commander";

import { registerBackfill } from "@/cli/commands/backfill/backfill";
import { registerCheck } from "@/cli/commands/check/check";
import { registerGraph } from "@/cli/commands/graph/graph";
import { registerServe } from "@/cli/commands/serve/serve";
import { registerSync } from "@/cli/commands/sync/sync";
import { registerTrigger } from "@/cli/commands/trigger/trigger";

process.on("SIGINT", () => {
  process.stdout.write("\x1B[?25h"); // restore cursor hidden by progress bars
  process.exit(130);
});

const program = new Command();
registerSync(program);
registerCheck(program);
registerGraph(program);
registerServe(program);
registerTrigger(program);
registerBackfill(program);
program.parse();
