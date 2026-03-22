import * as execState from "./exec-state";
import type { ExecResult, ExecuteOptions, Node, Outputs, ProcessNodeResult } from "./types";

export type RunNode = (
  node: Node,
  depContentHashes: Map<string, string>,
  depOutputs: Record<string, Outputs>,
) => Promise<ProcessNodeResult>;

export async function orchestrate(
  nodes: Iterable<Node>,
  run: RunNode,
  opts?: Pick<ExecuteOptions, "maxParallelism" | "concurrencyLimits" | "onAction">,
): Promise<ExecResult[]> {
  const { maxParallelism, concurrencyLimits, onAction } = opts ?? {};
  const state = execState.createExecState(nodes);
  const dispatch = (action: execState.ExecAction) => {
    execState.send(state, action);
    onAction?.(action);
  };

  let resumeLoop: () => void = () => {};
  while (execState.hasWork(state)) {
    let desc: Node | null;
    while ((desc = execState.tryTakeNext(state, maxParallelism, concurrencyLimits))) {
      const captured = desc;
      const failed = execState.failedDep(captured, state);
      if (failed) {
        dispatch({ type: "dep-failed", node: captured, error: new Error(`dependency ${failed} failed`) });
        dispatch({ type: "complete", node: captured });
        resumeLoop();
        continue;
      }
      const depContentHashes = new Map(captured.deps.map((d) => [d, state.contentHashes.get(d)!]));
      const depOutputs = execState.inputsFor(captured, state);
      run(captured, depContentHashes, depOutputs)
        .catch((e): ProcessNodeResult => ({
          name: captured.name,
          actionKey: "",
          status: "fail",
          error: e instanceof Error ? e.message : String(e),
          elapsed: 0,
        }))
        .then((result) => {
          for (const action of execState.resultToActions(captured, result)) dispatch(action);
          dispatch({ type: "complete", node: captured });
          resumeLoop();
        });
    }
    if (state.inflight === 0) continue;
    await new Promise<void>((r) => { resumeLoop = r; });
  }
  return [...state.execResults.values()];
}
