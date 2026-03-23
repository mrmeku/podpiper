import type { SchedulerContext, Scheduler } from "./orchestrate";
import type { Node } from "./types";

function schedulingLoop(hooks?: {
  filter?: (node: Node) => boolean;
  onStart?: (node: Node) => void;
  onEnd?: (node: Node) => void;
}): Scheduler {
  return async (ctx: SchedulerContext) => {
    while (ctx.hasWork()) {
      let node: Node | null;
      while ((node = ctx.take(hooks?.filter))) {
        const captured = node;
        hooks?.onStart?.(captured);
        ctx.run(captured).then(() => hooks?.onEnd?.(captured));
      }
      await ctx.workAvailable();
    }
  };
}

export function unboundedScheduler(): Scheduler {
  return schedulingLoop();
}

export interface ThrottledSchedulerOptions {
  maxParallelism?: number;
  concurrencyLimits?: Record<string, number>;
}

export function throttledScheduler(opts?: ThrottledSchedulerOptions): Scheduler {
  const { maxParallelism, concurrencyLimits } = opts ?? {};
  if (maxParallelism == null && concurrencyLimits == null) return unboundedScheduler();

  let inflight = 0;
  const groupInflight = new Map<string, number>();

  return schedulingLoop({
    filter(node) {
      if (maxParallelism != null && inflight >= maxParallelism) return false;
      if (!concurrencyLimits) return true;
      const group = node.concurrencyGroup;
      if (!group) return true;
      const limit = concurrencyLimits[group];
      return limit == null || (groupInflight.get(group) ?? 0) < limit;
    },
    onStart(node) {
      inflight++;
      const group = node.concurrencyGroup;
      if (group) groupInflight.set(group, (groupInflight.get(group) ?? 0) + 1);
    },
    onEnd(node) {
      inflight--;
      const group = node.concurrencyGroup;
      if (group) groupInflight.set(group, (groupInflight.get(group) ?? 0) - 1);
    },
  });
}
