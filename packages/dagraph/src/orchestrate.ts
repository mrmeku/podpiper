import * as execState from "./exec-state";
import type { ExecAction } from "./exec-state";
import type { ExecResult, Node, Outputs, ProcessNodeResult } from "./types";

export type RunNode = (
  node: Node,
  depContentHashes: Map<string, string>,
  depOutputs: Record<string, Outputs>,
) => Promise<ProcessNodeResult>;

export interface SchedulerContext {
  take(filter?: (node: Node) => boolean): Node | null;
  run(node: Node): Promise<void>;
  hasWork(): boolean;
  workAvailable(): Promise<void>;
}

export type Scheduler = (ctx: SchedulerContext) => Promise<void>;

export async function orchestrate(
  nodes: Iterable<Node>,
  run: RunNode,
  schedule: Scheduler,
  onAction?: (action: ExecAction) => void,
): Promise<ExecResult[]> {
  const state = execState.createExecState(nodes);
  let resumeLoop: () => void = () => {};

  const dispatch = (action: ExecAction) => {
    execState.send(state, action);
    onAction?.(action);
  };

  const done = (node: Node, result: ProcessNodeResult) => {
    for (const action of execState.resultToActions(node, result)) dispatch(action);
    dispatch({ type: "complete", node });
    resumeLoop();
  };

  const ctx: SchedulerContext = {
    take(filter) {
      return execState.tryTakeNext(state, filter);
    },
    run(node) {
      const failed = execState.failedDep(node, state);
      if (failed) {
        done(node, { name: node.name, actionKey: "", status: "dep-failed", error: `dependency ${failed} failed` });
        return Promise.resolve();
      }
      const depContentHashes = new Map(node.deps.map((d) => [d, state.contentHashes.get(d)!]));
      const depOutputs = execState.inputsFor(node, state);
      return run(node, depContentHashes, depOutputs)
        .catch((e): ProcessNodeResult => ({
          name: node.name, actionKey: "", status: "fail",
          error: e instanceof Error ? e.message : String(e), elapsed: 0,
        }))
        .then((result) => { done(node, result); });
    },
    hasWork() {
      return execState.hasWork(state);
    },
    workAvailable() {
      if (state.inflight === 0) return Promise.resolve();
      return new Promise<void>((r) => { resumeLoop = r; });
    },
  };

  await schedule(ctx);
  return [...state.execResults.values()];
}
