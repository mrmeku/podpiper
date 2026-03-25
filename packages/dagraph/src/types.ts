import type { Node, Outputs } from "./graph";

/** Discriminated union of per-node outcomes after DAG execution. */
export type ExecResult = { name: string; actionKey: string } & (
  | { status: "done"; outputs: Outputs; contentHash: string }
  | { status: "cached"; outputs: Outputs; contentHash: string }
  | { status: "fail"; error: Error }
  | { status: "dep-failed"; error: Error }
);

/** Result of processing a single node — returned by `processNode`. */
type ProcessNodeResultBase = { name: string; actionKey: string };
export type ProcessNodeResult = ProcessNodeResultBase &
  (
    | { status: "done"; outputs: Outputs; contentHash: string; elapsed: number }
    | { status: "cached"; outputs: Outputs; contentHash: string }
    | { status: "fail"; error: string; elapsed: number }
    | { status: "dep-failed"; error: string }
  );

/** Events dispatched during DAG execution — consumed by ExecState and optionally by progress UIs. */
export type ExecEvent =
  | { type: "start"; node: Node }
  | { type: "settled"; node: Node }
  | { type: "cached"; node: Node; actionKey: string; outputs: Outputs; contentHash: string }
  | {
      type: "done";
      node: Node;
      actionKey: string;
      outputs: Outputs;
      contentHash: string;
      elapsed: number;
    }
  | { type: "fail"; node: Node; error: unknown; elapsed: number }
  | { type: "dep-failed"; node: Node; error: unknown };
