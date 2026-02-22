# Hatchet TypeScript SDK v1 — API Reference

> Package: `@hatchet-dev/typescript-sdk`
> Docs: https://docs.hatchet.run
> Source: https://github.com/hatchet-dev/hatchet

---

## Client

```ts
import { Hatchet } from "@hatchet-dev/typescript-sdk";

export const hatchet = new Hatchet();
// Reads HATCHET_CLIENT_TOKEN from env automatically.
```

Convention: export from a single `hatchet-client.ts` file.

---

## Standalone Task

For single-function tasks (no DAG):

```ts
import { hatchet } from "../hatchet-client";

type SimpleInput = { Message: string };

export const simple = hatchet.task({
  name: "simple",
  fn: async (input: SimpleInput) => {
    return { TransformedMessage: input.Message.toLowerCase() };
  },

  // -- optional fields --
  retries: 3,
  executionTimeout: "60s", // default 60s; format: "<number><s|m|h>"
  scheduleTimeout: "5m", // default 5m; time in queue before cancel
});
```

The returned `Standalone` object can trigger runs directly:

```ts
const result = await simple.run({ Message: "Hello" });
// result is typed: { TransformedMessage: string }
```

### Task fn Signature

```ts
fn: async (input: InputType, ctx: Context) => OutputType;
```

`ctx` is the second argument. It's optional if you don't need it.

---

## Workflow (DAG)

For multi-task workflows with dependencies:

```ts
type DagInput = { Message: string };
type DagOutput = {
  "to-lower": { TransformedMessage: string };
  "to-upper": { TransformedMessage: string };
};

export const dag = hatchet.workflow<DagInput, DagOutput>({
  name: "simple",

  // -- optional: workflow-level concurrency --
  concurrency: {
    expression: "input.GroupKey", // CEL expression
    maxRuns: 1,
    limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN,
  },
});
```

### Adding Tasks to a Workflow

```ts
const toLower = dag.task({
  name: "to-lower",
  fn: (input) => {
    return { TransformedMessage: input.Message.toLowerCase() };
  },
});

const toUpper = dag.task({
  name: "to-upper",
  parents: [toLower], // task reference, not a string
  fn: (input, ctx) => {
    const prev = ctx.getParentOutput(toLower);
    // prev is typed as { TransformedMessage: string }
    return { TransformedMessage: input.Message.toUpperCase() };
  },
});
```

Run the workflow:

```ts
const result = await dag.run({ Message: "Hello" });
```

---

## Context API

Available as the second argument to `fn`:

| Method                                       | Description                                            |
| -------------------------------------------- | ------------------------------------------------------ |
| `ctx.getParentOutput(taskRef)`               | Type-safe output of a parent task in a DAG             |
| `ctx.runChild(taskOrWorkflow, input, opts?)` | Spawn a child workflow/task; returns `Promise<Output>` |
| `ctx.bulkRunChildren(items)`                 | Spawn multiple children in one API call (max 1000)     |
| `ctx.log(message)`                           | Emit a log visible in the Hatchet dashboard            |
| `ctx.abortController`                        | `AbortController` — signaled on timeout/cancellation   |
| `ctx.refreshTimeout(duration)`               | Extend execution timeout additively (e.g. `'15s'`)     |

### Child Spawning

```ts
export const child = hatchet.task({
  name: "child",
  fn: (input: { N: number }) => ({ Value: input.N }),
});

export const parent = hatchet.task({
  name: "parent",
  fn: async (input: { N: number }, ctx) => {
    // parallel fanout
    const promises = [];
    for (let i = 0; i < input.N; i++) {
      promises.push(ctx.runChild(child, { N: i }));
    }
    const results = await Promise.all(promises);
    return { Sum: results.reduce((a, c) => a + c.Value, 0) };
  },
});
```

You can also call `child.run(input)` directly (without `ctx.runChild`), but `runChild` associates the parent/child relationship in the dashboard.

### Bulk Children

```ts
const results = await ctx.bulkRunChildren([
  { workflow: child, input: { N: 1 } },
  { workflow: child, input: { N: 2 } },
]);
```

---

## Worker

```ts
import { hatchet } from "../hatchet-client";
import { simple } from "./workflow";
import { parent, child } from "./workflow-with-child";

async function main() {
  const worker = await hatchet.worker("my-worker", {
    workflows: [simple, parent, child], // register all tasks/workflows
    slots: 100, // max concurrent task executions on this worker
  });
  await worker.start();
}

main().catch(console.error);
```

All workflows/tasks must be registered at init time. You cannot add workflows after `worker.start()`.

---

## Flow Control

### Concurrency

Set on a workflow or standalone task. Uses CEL expressions for grouping.

```ts
import { ConcurrencyLimitStrategy } from "@hatchet-dev/typescript-sdk";

hatchet.workflow({
  name: "my-workflow",
  concurrency: {
    expression: "input.userId", // CEL expression
    maxRuns: 5,
    limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN,
  },
});
```

Strategies: `GROUP_ROUND_ROBIN`, `CANCEL_IN_PROGRESS`, `CANCEL_NEWEST`.

### Rate Limiting

Set per-task. Dynamic limits use CEL expressions.

```ts
import { RateLimitDuration } from "@hatchet-dev/typescript-sdk";

const task2 = hatchet.task({
  name: "task2",
  fn: (input: { userId: string }) => {
    /* ... */
  },
  rateLimits: [
    {
      dynamicKey: "input.userId", // CEL expression
      units: 1,
      limit: 10,
      duration: RateLimitDuration.MINUTE,
    },
  ],
});
```

Static rate limits (for shared resources like API keys) are declared with `hatchet.rateLimits.put()` before worker start.

---

## Timeouts

```ts
hatchet.task({
  name: "my-task",
  executionTimeout: "30s", // how long the task can run (default: 60s)
  scheduleTimeout: "10m", // how long it can sit in queue (default: 5m)
  fn: async (input, ctx) => {
    ctx.refreshTimeout("15s"); // additive: new timeout = 30s + 15s = 45s
    // ...
  },
});
```

Format: `<number><s|m|h>`. Seconds assumed if no unit.

---

## Retries

```ts
hatchet.task({
  name: "my-task",
  retries: 3, // retry up to 3 times on failure
  fn: async (input) => {
    /* ... */
  },
});
```

Timeouts count as failures and trigger retries.

---

## Durable Tasks

For long-running work that needs to sleep or wait for external events:

```ts
const durableTask = dag.durableTask({
  name: "wait-for-approval",
  fn: async (input, ctx) => {
    await ctx.sleepFor("1h");
    // or: await ctx.waitFor([condition]);
    return { approved: true };
  },
});
```

Durable tasks are automatically routed to a separate durable worker internally.

---

## Sticky Assignment

Pin child workflows to the same worker as the parent:

```ts
import { StickyStrategy } from "@hatchet-dev/typescript-sdk";

export const sticky = hatchet.task({
  name: "sticky",
  sticky: StickyStrategy.SOFT, // SOFT or HARD
  fn: async (_, ctx) => {
    const result = await ctx.runChild(child, { N: 1 }, { sticky: true });
    return { result };
  },
});
```

---

## Admin / Runs Client

Bulk operations on workflow runs:

```ts
const runs = hatchet.runs;

const failed = await runs.list({ statuses: [V1TaskStatus.FAILED] });
await runs.replay({ ids: failed.rows?.map((r) => r.metadata.id) });

await runs.cancel({
  filters: {
    since: new Date("2025-03-27"),
    additionalMetadata: { user: "123" },
  },
});
```

---

## Not Covered Here

These features exist but are outside the scope of a quick reference. See the linked docs:

- **Event triggers** — [docs](https://docs.hatchet.run/home/run-on-event)
- **Cron triggers** — [docs](https://docs.hatchet.run/home/cron-runs)
- **Scheduled runs** — [docs](https://docs.hatchet.run/home/scheduled-runs)
- **On-failure tasks** — [docs](https://docs.hatchet.run/home/on-failure-tasks)
- **Conditional workflows** (branching on parent output, sleep, events) — [docs](https://docs.hatchet.run/home/conditional-workflows)
- **Streaming** — [docs](https://docs.hatchet.run/home/streaming)
- **Logging & OpenTelemetry** — [docs](https://docs.hatchet.run/home/logging)
- **Priority queues** — [docs](https://docs.hatchet.run/home/priority)
