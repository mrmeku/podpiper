# Adding a Pipeline Action

1. **Add a `NodeKind` variant** in `src/pipeline/actions/define-action.ts`
2. **Create the action file** at `src/pipeline/actions/<name>.ts`:
   - Define a params interface extending `BaseParams` with `kind: typeof NodeKind.YourKind`
   - Add `videoId` + `outputDir` for per-video actions, or custom fields for channel-level ones
   - Declare deps via `deps: { depName: NodeRef<DepResultType> }`
   - Use `defineActionWithPorts` with a config string and an action function
   - Action must return file paths (`Outputs` = `string | string[] | Record<string, string | string[]>`)
3. **Define path helpers** if the action produces new artifacts. Add `toXxxFile(outputDir, videoId)` functions.
4. **Wire it into the graph** in `src/pipeline/graph-builder.ts`:
   - Call `yourAction.addNode(graph, ports, { kind, videoId, outputDir, deps: { ... } })`
   - The returned `NodeRef<R>` gets passed to downstream nodes via their `deps`
5. **Set the config string** to encode the action's semantic version — this is the cache invalidation trigger.
6. **If the action is optional** (like `summary`), make it conditional in `graph-builder.ts` based on config fields. The `deps` record supports `undefined` values for optional dependencies.

**Per-video vs channel-level:** Per-video actions use `toVideoActionName` → `"kind:videoId"`. Channel-level actions (like `channel_avatar`, `artwork`) use `(p) => p.kind` → static singleton name.

**Factory pattern for configurable actions:** `chapters()` and `summary()` are factory functions that accept a prompt and return an `Action`. The prompt is baked into the config object, so changing it invalidates the cache. Follow this pattern for any action whose behavior varies by channel config.
