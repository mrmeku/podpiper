import type { CreateWorkflowTaskOpts, HatchetClient } from "@hatchet-dev/typescript-sdk/v1";

export interface FakeTask {
  name: string;
  parents: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fn: (input: any, ctx: any) => Promise<any>;
}

export interface FakeWorkflow {
  opts: { name: string; on?: { cron?: string } };
  tasks: FakeTask[];
}

export function createFakeHatchet() {
  const workflows = new Map<string, FakeWorkflow>();

  const hatchet = {
    workflow: (opts: { name: string; on?: { cron?: string } }) => {
      const wf: FakeWorkflow = { opts, tasks: [] };
      workflows.set(opts.name, wf);
      return {
        definition: { name: opts.name },
        task: (taskOpts: CreateWorkflowTaskOpts<any, any>) => {
          const parentNames = (taskOpts.parents ?? []).map((p: any) => p.name);
          wf.tasks.push({ name: taskOpts.name, parents: parentNames, fn: taskOpts.fn! });
          return taskOpts;
        },
      };
    },
  } as unknown as HatchetClient;

  function getWorkflow(name: string): FakeWorkflow {
    const wf = workflows.get(name);
    if (!wf) throw new Error(`workflow "${name}" not registered`);
    return wf;
  }

  return { hatchet, getWorkflow, workflows };
}

function createFakeContext(
  parentOutputs: Map<string, unknown>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  childRunner?: (workflow: any, input: any) => Promise<any>,
) {
  return {
    parentOutput: async (ref: { name: string } | string) => {
      const name = typeof ref === "string" ? ref : ref.name;
      return parentOutputs.get(name);
    },
    runChild: childRunner ?? (async () => ({})),
    log: async () => {},
  };
}

/** Run all tasks in a fake workflow in registration order, wiring parent outputs. */
export async function runFakeWorkflow(
  wf: FakeWorkflow,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: any = {},
  allWorkflows?: Map<string, FakeWorkflow>,
) {
  const outputs = new Map<string, unknown>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const childRunner = allWorkflows ? async (wfRef: any, childInput: any) => {
    const name = wfRef?.definition?.name;
    const childWf = name ? allWorkflows.get(name) : undefined;
    if (!childWf) return {};
    const childOutputs = await runFakeWorkflow(childWf, childInput, allWorkflows);
    return childOutputs.get(childWf.tasks.at(-1)!.name);
  } : undefined;

  for (const task of wf.tasks) {
    const parentOutputs = new Map<string, unknown>();
    for (const p of task.parents) parentOutputs.set(p, outputs.get(p));
    const ctx = createFakeContext(parentOutputs, childRunner);
    outputs.set(task.name, await task.fn(input, ctx));
  }
  return outputs;
}
