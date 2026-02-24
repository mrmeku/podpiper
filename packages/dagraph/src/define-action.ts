import type { Graph } from "./graph";
import type { ActionFunc, DepsFor, NodeRef, Outputs } from "./types";

export interface ActionSpec<
  Ctx,
  Inputs extends Record<string, Outputs>,
  R extends Outputs,
  C = string,
> {
  config: C;
  action: (ctx: Ctx, config: C) => ActionFunc<Inputs, R>;
}

export type AddNodeFn<
  Ctx,
  Inputs extends Record<string, Outputs>,
  R extends Outputs,
> = Record<string, never> extends Inputs
  ? (graph: Graph, ctx: Ctx, id?: string) => NodeRef<R>
  : {
      (graph: Graph, ctx: Ctx, id: string, deps: DepsFor<Inputs>): NodeRef<R>;
      (graph: Graph, ctx: Ctx, deps: DepsFor<Inputs>): NodeRef<R>;
    };

export interface ActionDef<
  Ctx,
  Inputs extends Record<string, Outputs>,
  R extends Outputs,
> {
  kind: string;
  addNode: AddNodeFn<Ctx, Inputs, R>;
  createAction: (ctx: Ctx) => ActionFunc<Inputs, R>;
}

/** Extract output type R from an ActionDef or a factory function that returns one. */
export type OutputOf<T> =
  T extends ActionDef<any, any, infer R> ? R :
  T extends (...args: any[]) => ActionDef<any, any, infer R> ? R :
  never;

/** Extract NodeRef<R> from an ActionDef or a factory function that returns one. */
export type NodeRefOf<T> = NodeRef<OutputOf<T>>;

function stableStringify(obj: unknown) {
  return JSON.stringify(obj, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

export function defineAction<
  Ctx,
  Inputs extends Record<string, Outputs> = Record<string, never>,
  R extends Outputs = Outputs,
  C = string,
>(
  kind: string,
  spec: ActionSpec<Ctx, Inputs, R, C>,
): ActionDef<Ctx, Inputs, R> {
  const configStr = typeof spec.config === "string" ? spec.config : stableStringify(spec.config);

  const addNode = (
    graph: Graph,
    ctx: Ctx,
    idOrDeps?: string | Record<string, NodeRef | undefined>,
    maybeDeps?: Record<string, NodeRef | undefined>,
  ): NodeRef<R> => {
    let id: string | undefined;
    let deps: Record<string, NodeRef | undefined> | undefined;

    if (typeof idOrDeps === "string") {
      id = idOrDeps;
      deps = maybeDeps;
    } else if (idOrDeps && typeof idOrDeps === "object") {
      deps = idOrDeps;
    }

    const name = id ? `${kind}:${id}` : kind;
    const depNames = deps
      ? Object.values(deps).filter((v): v is NodeRef => v != null).map((v) => v.name)
      : [];

    const fn = spec.action(ctx, spec.config);
    graph.add({
      name,
      kind,
      deps: depNames,
      config: configStr,
      action: (rawInputs, outputDir) => {
        const inputs = deps
          ? (Object.fromEntries(
              Object.entries(deps)
                .map(([role, ref]) => [role, ref && rawInputs[ref.name]])
                .filter(([, v]) => v != null),
            ) as Inputs)
          : ({} as Inputs);
        return fn({ id, inputs, outputDir }) as Promise<Outputs>;
      },
    });
    return { name } as NodeRef<R>;
  };

  return {
    kind,
    addNode: addNode as AddNodeFn<Ctx, Inputs, R>,
    createAction: (ctx) => spec.action(ctx, spec.config),
  };
}
