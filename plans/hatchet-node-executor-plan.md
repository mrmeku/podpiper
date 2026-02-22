# Hatchet `serve` Command Plan

## Goal

Add a `serve` CLI command that runs podpiper as a long-lived local server. Hatchet orchestrates scheduled syncs for all configured channels, providing DAG visibility, per-task retry, and execution history via the Hatchet UI. The existing `sync` CLI command is unchanged.

```
bun run src/cli.ts sync heidi        # unchanged — local, one-shot
bun run src/cli.ts serve             # new — long-running Hatchet server
```

## Architecture

```
┌──────────────────────────────────────┐
│  serve process (long-running)        │
│                                      │
│  For each channel in config:         │
│    register channel-sync workflow    │
│    with on: { cron: "0 8 * * *" }   │
│                                      │
│  Start Hatchet worker               │
│  Worker executes tasks in-process    │
│  (has access to all ports)           │
└──────────┬───────────────────────────┘
           │ gRPC
┌──────────▼───────────────────────────┐
│  Hatchet server (Docker)             │
│  Postgres + Engine + UI              │
│  localhost:8080                       │
└──────────────────────────────────────┘
```

The `serve` process starts a single Hatchet worker that registers workflows for every channel defined in `src/config.ts`. Hatchet's cron scheduler triggers each channel's workflow daily. The worker executes tasks in-process — node actions have direct access to ports (yt-dlp, ffmpeg, whisper, claude, S3, filesystem).

## Why file-path outputs make this straightforward

Actions return `Outputs` — file paths (`string | string[] | Record<string, string | string[]>`). Hatchet serializes task outputs as JSON and deserializes them via `parentOutput()`. Since our outputs are just strings (file paths), they round-trip through Hatchet's JSON serialization without any ambiguity. The actual data lives on disk; Hatchet only passes lightweight path references between tasks.

The `defineActionWithPorts` pattern already separates the action function from the DAG wrapper. Each action exports a factory `(ports) => async (params, inputs) => Outputs` that can be called directly from Hatchet tasks — no refactoring needed.

## Workflow structure

Each channel gets two workflow definitions:

### 1. Channel sync workflow (cron-triggered)

One per channel (e.g., `heidi-sync`). Triggered daily by Hatchet cron. Contains three sequential tasks:

```
discover → spawnVideos → publish
```

- **discover**: calls `discoverVideos()` + `checkNewVideos()` to find unprocessed videos. Returns `VideoInfo[]`.
- **spawnVideos**: for each new video, spawns a child `video-pipeline` workflow via `ctx.runChild()`. Waits for all children. Collects their outputs (episodes + uploads).
- **publish**: receives collected results from spawnVideos, calls `publish()` to upload files and update feed.xml.

```typescript
const heidiSync = hatchet.workflow<void, SyncOutput>({
  name: 'heidi-sync',
  on: { cron: '0 8 * * *' },
});

const discover = heidiSync.task({
  name: 'discover',
  fn: async () => {
    const allVideos = await discoverVideos(config.channelUrl, ports.ytdlp);
    const existing = await getExistingVideoIds(config, ports.storage);
    const newVideos = allVideos.filter(v => !existing.has(v.id));
    return { videos: newVideos };
  },
});

const spawnVideos = heidiSync.task({
  name: 'spawn-videos',
  parents: [discover],
  fn: async (_, ctx) => {
    const { videos } = await ctx.parentOutput(discover);
    const results = await Promise.all(
      videos.map(video => ctx.runChild(videoPipeline, { video, channel: 'heidi' }))
    );
    return { episodes: results.map(r => r.episode), uploads: results.flatMap(r => r.uploads) };
  },
});

heidiSync.task({
  name: 'publish',
  parents: [spawnVideos],
  fn: async (_, ctx) => {
    const { episodes, uploads } = await ctx.parentOutput(spawnVideos);
    await publish({ episodes, uploads, results: [] }, config, ports.fs, ports.storage);
  },
});
```

### 2. Video pipeline workflow (spawned per video)

Each pipeline node is a Hatchet task. Actions are called directly via their exported factory — the same function that `defineActionWithPorts` wraps for the local DAG. Hatchet passes file paths between tasks via `parentOutput()`.

```
download → { transcribe, thumbnail }
               ↓
           chapters    summary (optional)
               ↓         ↓
             rssEntry
```

```typescript
const videoPipeline = hatchet.workflow<VideoInput, RssEntryResult>({
  name: 'video-pipeline',
});

const dl = videoPipeline.task({
  name: 'download',
  fn: async (input) => {
    // Returns { audio: string, info: JsonPath<YtDlpInfo>, thumb: string }
    return await download.action(ports)(
      { outputDir: input.outputDir, videoId: input.videoId },
      {},
    );
  },
});

const tr = videoPipeline.task({
  name: 'transcribe',
  parents: [dl],
  fn: async (input, ctx) => {
    const dlOut = await ctx.parentOutput(dl);
    return await transcribe.action(ports)(
      { outputDir: input.outputDir, videoId: input.videoId, deps: {} },
      { download: dlOut },
    );
  },
});

const th = videoPipeline.task({
  name: 'thumbnail',
  parents: [dl],
  fn: async (input, ctx) => {
    const dlOut = await ctx.parentOutput(dl);
    return await thumbnail.action(ports)(
      { outputDir: input.outputDir, videoId: input.videoId, deps: {} },
      { download: dlOut },
    );
  },
});

const ch = videoPipeline.task({
  name: 'chapters',
  parents: [dl, tr],
  fn: async (input, ctx) => {
    const dlOut = await ctx.parentOutput(dl);
    const trOut = await ctx.parentOutput(tr);
    return await chapters.action(ports)(
      { outputDir: input.outputDir, videoId: input.videoId, deps: {} },
      { download: dlOut, transcribe: trOut },
    );
  },
});

// rssEntry task gathers all parent outputs → returns { episode, uploads }
```

## Caching

The content-hash cache works naturally inside Hatchet tasks. Each task computes an `actionKey` from its config string + dependency content hashes, then checks the cache before running the action:

```typescript
fn: async (input, ctx) => {
  const dlOut = await ctx.parentOutput(dl);
  const depContentHashes = { download: await hashOutputFiles(dlOut, hashFile) };
  const actionKey = computeHash(taskName, config, depContentHashes);
  const entry = await cache.get(actionKey);
  if (entry && await verifyOutputs(entry)) return entry.outputs;

  const result = await action(ports, params, inputs);
  const contentHash = await hashOutputFiles(result, hashFile);
  await cache.put(actionKey, { outputs: result, contentHash });
  return result;
}
```

Cached tasks still appear in the Hatchet UI but complete instantly. This handles partial failure recovery: if `transcribe` failed but `download` succeeded, retrying the workflow skips download (cache hit) and re-runs transcribe.

The `discover` step also provides natural dedup — videos already in the feed aren't included, so successfully published videos won't generate child workflows on the next cron trigger.

## Concurrency

Worker-level `slots` controls total concurrent tasks across all channels. For resource-specific limits, use Hatchet concurrency keys:

```typescript
videoPipeline.task({
  name: 'download',
  concurrency: { expression: "'youtube-download'", maxRuns: 2 },
  fn: async (input) => { /* ... */ },
});
```

This limits YouTube downloads to 2 concurrent regardless of how many video pipelines are running.

## Changes by file

### New: `src/cli/commands/serve/serve.ts`

Registers the `serve` CLI command. Constructs ports, registers workflows for all channels, starts the Hatchet worker.

```typescript
export function registerServe(program: Command) {
  program
    .command('serve')
    .description('Run as a long-lived server with scheduled syncs')
    .option('-s, --slots <n>', 'Max concurrent tasks', (v) => parseInt(v), 4)
    .action(async (opts) => {
      const hatchet = Hatchet.init();
      const ports = createRealPorts({});
      const workflows = registerAllChannelWorkflows(hatchet, ports);
      const worker = await hatchet.worker('podpiper', {
        workflows,
        slots: opts.slots,
      });
      await worker.start();
    });
}
```

### New: `src/serve/workflows.ts`

Contains `registerAllChannelWorkflows()` which iterates `config.channels`, calls `registerChannelWorkflow()` for each. Also contains `videoPipeline` workflow definition.

### New: `src/serve/hatchet.ts`

Hatchet client initialization. Reads `HATCHET_CLIENT_TOKEN` from env.

### Modified: `src/cli/cli.ts`

Add `registerServe(program)`.

### Modified: `src/config.ts`

Export the `channels` record (currently only `getConfig` is exported; `serve` needs to iterate all channels).

Optionally add a `schedule` field per channel:

```typescript
type ChannelDef = Omit<Config, 'outputDir'> & {
  schedule?: string; // cron expression, default "0 8 * * *"
};
```

### No action refactoring needed

The `defineActionWithPorts` pattern already separates the action function from the DAG wrapper. Each action's `.action` property is a `(ports) => async (params, inputs) => Outputs` factory. Hatchet tasks call this directly, passing file paths from `parentOutput()` as `inputs`. The same function serves both the local DAG executor and Hatchet tasks.

## Failure and retry

Hatchet handles failure propagation natively. If `download` fails, `transcribe`/`thumbnail`/etc. don't execute. Retrying from the Hatchet UI re-dispatches the failed task to the worker.

At the channel-sync level: if `spawnVideos` fails (e.g., one child workflow fails), the `publish` task doesn't run. Next cron trigger starts fresh — `discover` finds the same unprocessed videos, child workflows re-run (cache handles skipping completed steps).

## Mac Mini setup

```bash
# Install Hatchet (requires Docker)
curl -fsSL https://install.hatchet.run/install.sh | bash

# Start server
hatchet server start

# Create API token in UI (localhost:8080)
export HATCHET_CLIENT_TOKEN="<your-token>"

# Start podpiper server
bun run src/cli.ts serve
```

## Open questions

1. **Channel artwork** — Currently a shared node across videos. In the Hatchet model, it could be a task in the channel-sync workflow (before `spawnVideos`) or handled inside `publish`. Decide during implementation.
2. **Graceful shutdown** — The worker should handle SIGTERM cleanly (finish in-progress tasks, flush cache). Hatchet's worker SDK may handle this already.
