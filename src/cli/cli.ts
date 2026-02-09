#!/usr/bin/env bun
import { Command } from "commander";

import { registerCheck } from "@/cli/commands/check/check";
import { registerGraph } from "@/cli/commands/graph/graph";
import { registerSync } from "@/cli/commands/sync/sync";

const program = new Command();
registerSync(program);
registerCheck(program);
registerGraph(program);
program.parse();
