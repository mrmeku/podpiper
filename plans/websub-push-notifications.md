# WebSub Push Notifications + Atom RSS

## Background

### The Discovery Problem

`yt-dlp --flat-playlist` scrapes YouTube's website to discover videos. This is the most fingerprintable operation: it hits YouTube on a predictable schedule from the same IP, using a recognizable scraping pattern. Even with TLS impersonation and jitter, it's still a recurring scrape of the channel page.

### YouTube Atom RSS Feeds

YouTube provides Atom feeds at `https://www.youtube.com/feeds/videos.xml?channel_id=CHANNEL_ID`:
- Returns the **15 most recent** videos per channel
- Each entry contains `<yt:videoId>`, `<published>`, `<title>`, `<media:thumbnail>`, `<media:description>`
- HTTP headers show `Cache-Control: public, max-age=900` (15-minute cache)
- **No authentication required**, no API key, no quota system
- Delay: 15-60 minutes after upload before appearing in the feed

The feed is limited to 15 entries, so for initial backfill you still need yt-dlp. For ongoing discovery, the Atom feed is sufficient and far lighter than scraping.

### WebSub (PubSubHubbub) Push Notifications

YouTube's Atom feeds support WebSub push notifications via Google's hub at `https://pubsubhubbub.appspot.com/`. Instead of polling, YouTube pushes new video notifications to a callback endpoint with seconds of latency.

**Known YouTube WebSub quirks** (from [Kevin Cox's writeup](https://kevincox.ca/2021/12/16/youtube-websub/)):
- YouTube does NOT advertise the hub link in feed XML — you must know the hub URL
- Topic URL format is non-standard: `/xml/feeds/` path prefix instead of `/feeds/`
- Notification payload may have empty body — treat as a "ping" and re-fetch the Atom feed
- Subscriptions expire after 5-10 days; must resubscribe before lease expiry
- Despite quirks, push notifications DO arrive and are generally reliable

### Why Not YouTube API v3?

The YouTube Data API v3 costs 1 unit per `playlistItems.list` call (10,000 units/day free). For 10 channels every 15 minutes: 960 units/day — well within limits. But it adds a Google Cloud project + API key dependency. The Atom feed + WebSub approach achieves the same thing with zero auth requirements and fits naturally with the existing Cloudflare infrastructure.

### Comparison

| Approach | YouTube Requests | Latency | Auth | Risk |
|---|---|---|---|---|
| yt-dlp --flat-playlist (current) | High (scraping) | 0 | None | High |
| Atom RSS polling | Low (1 GET/channel) | 15-60 min | None | Low |
| WebSub push | Zero for discovery | Seconds | None | Very low |
| YouTube API v3 | Low (1 unit/call) | On-demand | API key | None |

---

## Implementation Plan

## Phase 1: Atom RSS Discovery

### 1a. Add `channelId` to config

**Modify `src/types.ts`** -- add `channelId` to `Config`:

```typescript
export interface Config {
  channelUrl: string;
  channelId: string;  // YouTube channel ID (UCxxxxxxx), required for Atom feeds
  outputDir: string;
  casBaseDir: string;
  storage: StorageConfig;
  podcast: PodcastConfig;
  summaryPrompt?: string;
  chapterPrompt?: string;
  startDate?: string;
  playlistOffset?: number;
  skipTranscribe?: boolean;
}
```

**Modify `src/config.ts`** -- add `channelId` to each channel definition:

```typescript
export const channels: Record<string, ChannelDef> = {
  heidi: {
    channelUrl: "https://www.youtube.com/@heidipriebe1/videos",
    channelId: "UCuo6NzjawJRViOmGKaITjdg",
    // ... rest unchanged
  },
  atrioc: {
    channelUrl: "https://www.youtube.com/channel/UCdBXOyqr8cDshsp7kcKDAkg/videos",
    channelId: "UCdBXOyqr8cDshsp7kcKDAkg",
    // ... rest unchanged
  },
  asianometry: {
    channelUrl: "https://www.youtube.com/asianometry",
    channelId: "UCjkLFg3drThDCq1fro0ZiYg",
    // ... rest unchanged
  },
  hgmodernism: {
    channelUrl: "https://www.youtube.com/@HGModernism/videos",
    channelId: "UCxxxxxxxxxxxxxxxxxxxxxxx",  // resolve before merge
    // ... rest unchanged
  },
};
```

### 1b. One-time script to resolve channel IDs

**Create `scripts/resolve-channel-ids.ts`**:

```typescript
import { channels } from "@/config";
import { exec } from "@/ports/exec";

for (const [name, def] of Object.entries(channels)) {
  const output = await exec([
    "yt-dlp",
    "--print", "channel_id",
    "--playlist-items", "1",
    def.channelUrl,
  ]);
  console.log(`${name}: ${output.trim()}`);
}
```

Run once: `bun scripts/resolve-channel-ids.ts`, paste the IDs into `src/config.ts`, delete the script.

Alternative (no yt-dlp): visit `https://www.youtube.com/@handle` in a browser, view page source, search for `"channelId":"UC..."`.

### 1c. Add `fetchRecentVideos` to the port

**Modify `src/ports/types.ts`** -- extend `YouTubeDownloader`:

```typescript
export interface YouTubeDownloader {
  fetchVideoList: (config: Pick<Config, "channelUrl" | "playlistOffset" | "startDate">) => Promise<VideoInfo[]>;
  fetchRecentVideos: (channelId: string) => Promise<VideoInfo[]>;
  fetchVideoTitles: (videoIds: string[]) => Promise<Record<string, string>>;
  downloadAudio: (outputDir: string, videoId: string) => Promise<void>;
  downloadChannelArtwork: (outputDir: string, channelUrl: string) => Promise<void>;
}
```

**Modify `src/ports/ytdlp.ts`** -- add implementation to `createRealYtdlp`:

```typescript
import { XMLParser } from "fast-xml-parser";

// Add inside createRealYtdlp's return object:
fetchRecentVideos: async (channelId) => {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Atom feed fetch failed: ${response.status}`);
  const xml = await response.text();
  return parseAtomFeed(xml);
},
```

`fast-xml-parser` is already a dependency. Add the parser function at module level in `src/ports/ytdlp.ts`:

```typescript
const atomParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

export function parseAtomFeed(xml: string): VideoInfo[] {
  const feed = atomParser.parse(xml);
  const entries = Array.isArray(feed.feed.entry) ? feed.feed.entry : feed.feed.entry ? [feed.feed.entry] : [];
  return entries.map((entry: Record<string, string>) => {
    const videoId = entry["yt:videoId"];
    const published = entry.published; // "2026-03-15T18:00:00+00:00"
    const uploadDate = published.slice(0, 10).replace(/-/g, "");
    return { id: videoId, uploadDate, title: entry.title };
  });
}
```

**Modify `src/ports/stub.ts`** -- add stub:

```typescript
fetchRecentVideos: async () => [],
```

**Modify `src/ports/mock.ts`** -- add mock (inside `createMockPorts`, the `ytdlp` block):

```typescript
fetchRecentVideos: async () => [],
```

### 1d. Integrate into the discover activity

**Modify `src/cli/commands/serve/activities.ts`** -- change `discover` to prefer Atom feed:

```typescript
async discover(input: DiscoverInput): Promise<DiscoverResult> {
  const { config } = defaultResolve(ports, configResolver, input.channelName);

  // Atom feed for incremental discovery (15 most recent, no scraping)
  const allVideos = await ports.ytdlp.fetchRecentVideos(config.channelId);

  const feedData = await ports.storage.getFile(config.storage.bucket, "feed.xml");
  const existing = new Set<string>();
  if (feedData) {
    const episodes = parseExistingFeed(
      config.storage.publicUrl,
      new TextDecoder().decode(feedData),
    );
    for (const ep of episodes) existing.add(ep.id);
  }
  const newVideos = allVideos.filter((v) => !existing.has(v.id));
  return {
    videos: newVideos.map((v) => ({
      video: v,
      descriptors: buildVideoGraph(v, ports, config).describe(),
    })),
  };
},
```

`fetchVideoList` (yt-dlp `--flat-playlist`) stays available for backfill via the existing `sync` CLI command. The Temporal-driven `channelWorkflow` uses only `fetchRecentVideos`.

### 1e. Tests

**Create `src/ports/ytdlp-atom.test.ts`** -- test `parseAtomFeed` with a fixture:

```typescript
import { describe, expect, test } from "bun:test";
import { parseAtomFeed } from "./ytdlp";

const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"
      xmlns:media="http://search.yahoo.com/mrss/"
      xmlns="http://www.w3.org/2005/Atom">
  <title>Channel Title</title>
  <entry>
    <yt:videoId>dQw4w9WgXcQ</yt:videoId>
    <title>Test Video One</title>
    <published>2026-03-15T18:00:00+00:00</published>
  </entry>
  <entry>
    <yt:videoId>abc123def45</yt:videoId>
    <title>Test Video Two</title>
    <published>2026-03-10T12:30:00+00:00</published>
  </entry>
</feed>`;

describe("parseAtomFeed", () => {
  test("parses Atom XML into VideoInfo array", () => {
    expect(parseAtomFeed(FIXTURE)).toEqual([
      { id: "dQw4w9WgXcQ", uploadDate: "20260315", title: "Test Video One" },
      { id: "abc123def45", uploadDate: "20260310", title: "Test Video Two" },
    ]);
  });
});
```

### Phase 1 file summary

| File | Action |
|---|---|
| `src/types.ts` | Add `channelId` to `Config` |
| `src/config.ts` | Add `channelId` values to each channel |
| `scripts/resolve-channel-ids.ts` | Create one-time script, run, delete |
| `src/ports/types.ts` | Add `fetchRecentVideos` to `YouTubeDownloader` |
| `src/ports/ytdlp.ts` | Add `parseAtomFeed` + `fetchRecentVideos` impl |
| `src/ports/stub.ts` | Add `fetchRecentVideos` stub |
| `src/ports/mock.ts` | Add `fetchRecentVideos` mock |
| `src/cli/commands/serve/activities.ts` | Switch discover to use `fetchRecentVideos` |
| `src/ports/ytdlp-atom.test.ts` | Create test for `parseAtomFeed` |

---

## Phase 2: WebSub Worker

### 2a. Project structure

```
workers/websub/
  src/index.ts        # Worker fetch + scheduled handlers
  wrangler.toml       # Cloudflare Worker config
  package.json        # Minimal deps
  tsconfig.json
```

This is a standalone Cloudflare Worker project, not a podpiper workspace package. It deploys independently via `wrangler deploy`.

### 2b. wrangler.toml

**Create `workers/websub/wrangler.toml`**:

```toml
name = "podpiper-websub"
main = "src/index.ts"
compatibility_date = "2026-03-01"

[[kv_namespaces]]
binding = "KV"
id = ""          # fill after `wrangler kv namespace create PODPIPER_WEBSUB`

[triggers]
crons = ["0 */6 * * *"]   # resubscribe every 6 hours (leases are 5-10 days, but cheap to resubscribe)

[vars]
CALLBACK_URL = "https://websub.podpiper.mrmeku.com/websub"
```

### 2c. KV namespace setup

```bash
cd workers/websub
npx wrangler kv namespace create PODPIPER_WEBSUB
# Copy the returned ID into wrangler.toml
```

### 2d. Worker code

**Create `workers/websub/src/index.ts`**:

```typescript
interface Env {
  KV: KVNamespace;
  CALLBACK_URL: string;
}

const CHANNELS: Record<string, string> = {
  heidi: "UCuo6NzjawJRViOmGKaITjdg",
  atrioc: "UCdBXOyqr8cDshsp7kcKDAkg",
  asianometry: "UCjkLFg3drThDCq1fro0ZiYg",
  hgmodernism: "UCxxxxxxxxxxxxxxxxxxxxxxx",
};

const HUB_URL = "https://pubsubhubbub.appspot.com/subscribe";

function topicUrl(channelId: string): string {
  return `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channelId}`;
}

function parseVideoIds(xml: string): string[] {
  const ids: string[] = [];
  const re = /<yt:videoId>([^<]+)<\/yt:videoId>/g;
  let match;
  while ((match = re.exec(xml)) !== null) ids.push(match[1]!);
  return ids;
}

function resolveChannelId(xml: string): string | null {
  const match = xml.match(/<yt:channelId>([^<]+)<\/yt:channelId>/);
  return match?.[1] ?? null;
}

async function subscribe(channelId: string, callbackUrl: string): Promise<Response> {
  const body = new URLSearchParams({
    "hub.callback": callbackUrl,
    "hub.topic": topicUrl(channelId),
    "hub.verify": "async",
    "hub.mode": "subscribe",
    "hub.lease_seconds": "864000",
  });
  return fetch(HUB_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/websub")) return new Response("Not Found", { status: 404 });

    // WebSub verification (GET with hub.challenge)
    if (request.method === "GET") {
      const challenge = url.searchParams.get("hub.challenge");
      if (challenge) return new Response(challenge, { status: 200 });
      return new Response("Missing challenge", { status: 400 });
    }

    // WebSub notification (POST)
    if (request.method === "POST") {
      const body = await request.text();

      // Resolve which channel this notification is for
      const channelId = resolveChannelId(body);

      // Notifications may have an empty body or no video IDs -- treat as a ping
      const videoIds = parseVideoIds(body);

      if (videoIds.length > 0 && channelId) {
        for (const id of videoIds) {
          await env.KV.put(
            `pending:${channelId}:${id}`,
            JSON.stringify({ discoveredAt: Date.now() }),
            { expirationTtl: 86400 * 7 }, // auto-expire after 7 days
          );
        }
      } else if (channelId) {
        // Empty-body ping: fetch the Atom feed ourselves and store any new IDs
        const feedResp = await fetch(topicUrl(channelId));
        if (feedResp.ok) {
          const feedXml = await feedResp.text();
          const ids = parseVideoIds(feedXml);
          for (const id of ids) {
            const existing = await env.KV.get(`pending:${channelId}:${id}`);
            if (!existing) {
              await env.KV.put(
                `pending:${channelId}:${id}`,
                JSON.stringify({ discoveredAt: Date.now() }),
                { expirationTtl: 86400 * 7 },
              );
            }
          }
        }
      }

      return new Response("OK", { status: 200 });
    }

    return new Response("Method Not Allowed", { status: 405 });
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    for (const channelId of Object.values(CHANNELS)) {
      const resp = await subscribe(channelId, env.CALLBACK_URL);
      console.log(`Resubscribe ${channelId}: ${resp.status}`);
    }
  },
} satisfies ExportedHandler<Env>;
```

### 2e. Worker package.json

**Create `workers/websub/package.json`**:

```json
{
  "name": "podpiper-websub",
  "private": true,
  "scripts": {
    "deploy": "wrangler deploy",
    "dev": "wrangler dev"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20260101.0",
    "wrangler": "^4.0.0"
  }
}
```

### 2f. How podpiper reads from KV during discovery

The Temporal worker reads pending video IDs from the WebSub KV before falling back to Atom feed polling. This requires the podpiper server to have a Cloudflare API token with KV read/list permissions.

**Modify `src/ports/types.ts`** -- add a `VideoNotificationStore` port:

```typescript
export interface VideoNotificationStore {
  getPendingVideoIds: (channelId: string) => Promise<string[]>;
  clearPendingVideoId: (channelId: string, videoId: string) => Promise<void>;
}

export interface Ports {
  fs: FileSystem;
  ytdlp: YouTubeDownloader;
  ffmpeg: MediaProcessor;
  whisper: Transcriber;
  claude: Llm;
  storage: ObjectStore;
  clock: Clock;
  notifications: VideoNotificationStore;
}
```

**Create `src/ports/kv.ts`** -- KV-backed implementation using Cloudflare REST API:

```typescript
import type { VideoNotificationStore } from "./types";

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

export function createKvNotificationStore(
  accountId: string,
  namespaceId: string,
  apiToken: string,
): VideoNotificationStore {
  const headers = { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" };

  return {
    async getPendingVideoIds(channelId) {
      const url = `${CF_API_BASE}/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/keys?prefix=pending:${channelId}:`;
      const resp = await fetch(url, { headers });
      if (!resp.ok) return [];
      const data = (await resp.json()) as { result: { name: string }[] };
      return data.result.map((k) => k.name.split(":")[2]!);
    },
    async clearPendingVideoId(channelId, videoId) {
      const url = `${CF_API_BASE}/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/pending:${channelId}:${videoId}`;
      await fetch(url, { method: "DELETE", headers });
    },
  };
}
```

**Modify `src/cli/commands/serve/activities.ts`** -- discover checks KV first:

```typescript
async discover(input: DiscoverInput): Promise<DiscoverResult> {
  const { config } = defaultResolve(ports, configResolver, input.channelName);

  // Check WebSub KV for push-notified video IDs
  const pendingIds = await ports.notifications.getPendingVideoIds(config.channelId);

  let allVideos: VideoInfo[];
  if (pendingIds.length > 0) {
    // We have push-notified IDs -- fetch their titles from yt-dlp (single metadata call, no scraping)
    const titles = await ports.ytdlp.fetchVideoTitles(pendingIds);
    allVideos = pendingIds
      .filter((id) => titles[id])
      .map((id) => ({ id, uploadDate: "", title: titles[id]! }));
    // uploadDate will be resolved during download (yt-dlp writes info.json)

    // Also supplement with Atom feed for anything push may have missed
    const atomVideos = await ports.ytdlp.fetchRecentVideos(config.channelId);
    const seen = new Set(allVideos.map((v) => v.id));
    for (const v of atomVideos) {
      if (!seen.has(v.id)) allVideos.push(v);
    }
  } else {
    // No push notifications -- fall back to Atom feed
    allVideos = await ports.ytdlp.fetchRecentVideos(config.channelId);
  }

  const feedData = await ports.storage.getFile(config.storage.bucket, "feed.xml");
  const existing = new Set<string>();
  if (feedData) {
    const episodes = parseExistingFeed(
      config.storage.publicUrl,
      new TextDecoder().decode(feedData),
    );
    for (const ep of episodes) existing.add(ep.id);
  }
  const newVideos = allVideos.filter((v) => !existing.has(v.id));

  // Clear processed pending IDs from KV
  for (const v of newVideos) {
    await ports.notifications.clearPendingVideoId(config.channelId, v.id);
  }

  return {
    videos: newVideos.map((v) => ({
      video: v,
      descriptors: buildVideoGraph(v, ports, config).describe(),
    })),
  };
},
```

**Modify `.env.tpl`** -- add KV credentials:

```
CLOUDFLARE_KV_NAMESPACE_ID=op://Private/podpiper/CLOUDFLARE_KV_NAMESPACE_ID
```

**Modify `src/ports/real.ts`** -- wire up the KV store:

```typescript
import { createKvNotificationStore } from "./kv";

export function createRealPorts(opts?: { force?: boolean; cookies?: boolean }): Ports {
  return {
    // ... existing ports unchanged
    notifications: createKvNotificationStore(
      process.env.R2_ACCOUNT_ID!,  // same Cloudflare account
      process.env.CLOUDFLARE_KV_NAMESPACE_ID!,
      process.env.R2_ADMIN_API_TOKEN!,  // reuse existing admin token
    ),
  };
}
```

**Modify `src/ports/stub.ts`** and **`src/ports/mock.ts`** -- add stub/mock:

```typescript
// stub.ts
notifications: {
  getPendingVideoIds: async () => [],
  clearPendingVideoId: async () => {},
},

// mock.ts
notifications: {
  getPendingVideoIds: async () => [],
  clearPendingVideoId: async () => {},
  ...overrides?.notifications,
},
```

### 2g. Initial subscription bootstrap

After deploying the Worker, manually trigger the first subscription:

```bash
cd workers/websub && npx wrangler dev --test-scheduled
# Hit the scheduled endpoint in another terminal:
curl "http://localhost:8787/__scheduled?cron=0+*/6+*+*+*"
```

Or deploy and wait for the first cron trigger (within 6 hours).

### Phase 2 file summary

| File | Action |
|---|---|
| `workers/websub/src/index.ts` | Create Worker with fetch + scheduled handlers |
| `workers/websub/wrangler.toml` | Create Worker config |
| `workers/websub/package.json` | Create package manifest |
| `workers/websub/tsconfig.json` | Create (standard Workers tsconfig) |
| `src/ports/types.ts` | Add `VideoNotificationStore` interface, add to `Ports` |
| `src/ports/kv.ts` | Create KV-backed notification store |
| `src/ports/real.ts` | Wire `notifications` port |
| `src/ports/stub.ts` | Add `notifications` stub |
| `src/ports/mock.ts` | Add `notifications` mock |
| `src/cli/commands/serve/activities.ts` | Update discover to check KV then Atom |
| `.env.tpl` | Add `CLOUDFLARE_KV_NAMESPACE_ID` |

---

## Phase 3: Fallback Polling

The WebSub Worker's `scheduled` handler already runs every 6 hours for resubscription. Add a second cron at 30-minute intervals that polls each channel's Atom feed and writes any new video IDs to KV. This acts as a safety net for missed WebSub pushes.

### 3a. Add polling cron to wrangler.toml

**Modify `workers/websub/wrangler.toml`**:

```toml
[triggers]
crons = ["0 */6 * * *", "*/30 * * * *"]
```

### 3b. Extend the scheduled handler

**Modify `workers/websub/src/index.ts`** -- split scheduled handler by cron pattern:

```typescript
async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
  if (event.cron === "0 */6 * * *") {
    // Resubscribe to WebSub hub
    for (const channelId of Object.values(CHANNELS)) {
      const resp = await subscribe(channelId, env.CALLBACK_URL);
      console.log(`Resubscribe ${channelId}: ${resp.status}`);
    }
  }

  if (event.cron === "*/30 * * * *") {
    // Poll Atom feeds as fallback
    for (const [name, channelId] of Object.entries(CHANNELS)) {
      const resp = await fetch(topicUrl(channelId));
      if (!resp.ok) {
        console.log(`Atom poll failed for ${name}: ${resp.status}`);
        continue;
      }
      const xml = await resp.text();
      const videoIds = parseVideoIds(xml);
      let newCount = 0;
      for (const id of videoIds) {
        const key = `pending:${channelId}:${id}`;
        const existing = await env.KV.get(key);
        if (!existing) {
          await env.KV.put(key, JSON.stringify({ discoveredAt: Date.now(), source: "poll" }), {
            expirationTtl: 86400 * 7,
          });
          newCount++;
        }
      }
      if (newCount > 0) console.log(`Poll found ${newCount} new videos for ${name}`);
    }
  }
},
```

### Phase 3 file summary

| File | Action |
|---|---|
| `workers/websub/wrangler.toml` | Add `*/30 * * * *` cron |
| `workers/websub/src/index.ts` | Add Atom polling branch to scheduled handler |

---

## Deployment Order

1. **Phase 1** -- ship the Atom feed path. Discover activity switches from yt-dlp scraping to Atom HTTP GET. No infra changes, just code. Verify with `bun test` and a manual Temporal workflow trigger.

2. **Phase 2** -- deploy the Worker. Run `npx wrangler kv namespace create PODPIPER_WEBSUB`, fill in the namespace ID, deploy with `npx wrangler deploy`. Trigger initial subscriptions. Update the Temporal worker with the KV-reading discover logic.

3. **Phase 3** -- add the polling cron to the already-deployed Worker via `npx wrangler deploy`. No changes to the main podpiper codebase.

## Rollback

Each phase is independently revertible:
- Phase 1: change `fetchRecentVideos` back to `fetchVideoList` in the discover activity (one line)
- Phase 2: remove KV checks from discover, delete Worker (`npx wrangler delete`)
- Phase 3: remove the `*/30` cron from wrangler.toml, redeploy

## Open Questions

1. **uploadDate from WebSub**: push notifications do not always include `published` date. The current approach uses `fetchVideoTitles` which only gets titles. Options: (a) parse the Atom feed supplementally to get dates, (b) let the download step resolve it from `info.json`, (c) add a `fetchVideoMetadata` port method. Recommendation: (a), since we already fetch the Atom feed as a supplement.

2. **Channel ID duplication**: the Worker hardcodes `CHANNELS` separately from `src/config.ts`. Consider generating the Worker's channel list from config at build time, or using a shared KV key that the main process writes to.

3. **Worker domain**: needs a route configured in Cloudflare DNS. Could add this to `terraform/main.tf` or configure manually. If using terraform, add a `cloudflare_worker_route` resource pointing `websub.podpiper.mrmeku.com/*` to the Worker.

## Sources

- [YouTube Data API Push Notifications Guide](https://developers.google.com/youtube/v3/guides/push_notifications)
- [YouTube's Wonky WebSub — Kevin Cox](https://kevincox.ca/2021/12/16/youtube-websub/)
- [Google WebSub is DoSing Me — Kevin Cox](https://kevincox.ca/2022/05/08/google-websub-dos/)
- [youtube-notification npm package](https://www.npmjs.com/package/youtube-notification)
- [YouTube Data API Quota Calculator](https://developers.google.com/youtube/v3/determine_quota_cost)
- [WebSub — Wikipedia](https://en.wikipedia.org/wiki/WebSub)
- [PubSubHubbub Core 0.4 Spec](https://pubsubhubbub.github.io/PubSubHubbub/pubsubhubbub-core-0.4.html)
