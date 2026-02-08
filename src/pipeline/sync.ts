import { localRunner } from "@/dag/graph";
import type { Graph } from "@/dag/graph";
import type { ExecResult, ExecuteOptions } from "@/dag/types";
import type { Episode, UploadEntry } from "@/types";

import type { EpisodeOutput } from "./actions/rss-entry";
import type { PipelineRefs } from "./graph-builder";

export interface SyncResult {
  uploads: UploadEntry[];
  results: ExecResult[];
  episodes: Episode[];
}

export async function sync(
  graph: Graph,
  refs: PipelineRefs,
  opts?: ExecuteOptions,
): Promise<SyncResult> {
  const { publishRefs, entryRefs } = refs;
  const results = await graph.execute(localRunner, opts);
  const resultsByName = new Map(results.map((r) => [r.name, r]));
  const uploads: UploadEntry[] = [];
  for (const ref of publishRefs) {
    const r = resultsByName.get(ref.name);
    if (!r || r.status !== "done") continue;
    uploads.push(...ref.parse(r.result).uploads);
  }
  const episodes = entryRefs
    .map((ref) => {
      const r = resultsByName.get(ref.name);
      if (!r || r.status === "fail" || r.status === "dep-failed") return null;
      return (JSON.parse(r.result) as EpisodeOutput).episode;
    })
    .filter((ep) => ep !== null);
  return { uploads, results, episodes };
}
