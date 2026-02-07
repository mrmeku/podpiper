import { Graph } from "@/dag/graph";
import type { Cache, ExecResult } from "@/dag/types";
import type { Ports } from "@/ports/types";
import type { Config, Episode, UploadEntry, VideoInfo } from "@/types";

import type { EpisodeOutput } from "./actions/rss-entry";
import { buildPipelineGraph } from "./graph-builder";

export interface SyncResult {
  uploads: UploadEntry[];
  results: ExecResult[];
  episodes: Episode[];
}

export async function sync(
  videos: VideoInfo[],
  config: Config,
  ports: Ports,
  cache: Cache,
  maxParallelism = 4,
): Promise<SyncResult> {
  const graph = new Graph(cache);
  const { publishRefs, entryRefs } = buildPipelineGraph(
    graph,
    videos,
    ports,
    config,
  );
  const results = await graph.execute(maxParallelism);
  const resultsByName = new Map(results.map((r) => [r.name, r]));
  const uploads: UploadEntry[] = [];
  for (const ref of publishRefs) {
    const r = resultsByName.get(ref.name);
    if (!r || r.error || r.result === null || r.skipped) continue;
    uploads.push(...ref.parse(r.result).uploads);
  }
  const episodes = entryRefs
    .map((ref) => {
      const r = resultsByName.get(ref.name);
      if (!r || r.error || r.result === null) return null;
      return (JSON.parse(r.result) as EpisodeOutput).episode;
    })
    .filter((ep) => ep !== null);
  return { uploads, results, episodes };
}
