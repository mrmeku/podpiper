import type { FileSystem } from "@/ports/types";
import type { JsonPath } from "@/typed-path";
import { readJson } from "@/typed-path";
import type { Episode, UploadEntry } from "@/types";
import type { ExecutionContext } from "@podpiper/dag/execute";
import { execute } from "@podpiper/dag/execute";
import type { Graph } from "@podpiper/dag/graph";
import { localRunner } from "@podpiper/dag/graph";
import type { ExecResult, ExecuteOptions } from "@podpiper/dag/types";

import type { PipelineRefs } from "@/pipeline/graph-builder";
import type { RssEntryResult } from "@/pipeline/actions/rss-entry";

export interface SyncResult {
  uploads: UploadEntry[];
  results: ExecResult[];
  episodes: Episode[];
}

export async function sync(
  graph: Graph,
  refs: PipelineRefs,
  fs: FileSystem,
  executionCtx: ExecutionContext,
  opts?: ExecuteOptions,
): Promise<SyncResult> {
  const { entryRefs, artworkRef } = refs;
  const results = await execute(graph, executionCtx, localRunner, opts);
  const resultsByName = new Map(results.map((r) => [r.name, r]));
  const uploads: UploadEntry[] = [];
  const episodes: Episode[] = [];

  for (const ref of entryRefs) {
    const r = resultsByName.get(ref.name);
    if (!r || (r.status !== "done" && r.status !== "cached")) continue;
    const paths = r.outputs as RssEntryResult;
    const episode = await readJson(fs, paths.episode);
    const entryUploads = await readJson(fs, paths.uploads);
    episodes.push(episode);
    if (r.status === "done") {
      uploads.push(...entryUploads);
    }
  }

  const artworkResult = resultsByName.get(artworkRef.name);
  if (artworkResult && artworkResult.status === "done") {
    const uploadsPath = artworkResult.outputs as JsonPath<UploadEntry[]>;
    const artworkUploads = await readJson(fs, uploadsPath);
    uploads.push(...artworkUploads);
  }

  return { uploads, results, episodes };
}
