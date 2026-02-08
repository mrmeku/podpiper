import type { Graph } from "@/dag/graph";
import { addNode } from "@/dag/graph";
import type { ActionFunc, DepName, NodeRef } from "@/dag/types";
import { dep } from "@/dag/types";
import { toVideoDir } from "@/paths";
import type { MediaProcessor } from "@/ports/types";

import type { DownloadResult } from "./download";
import { NodeKind } from "./node-kind";

export interface ThumbnailParams {
  kind: typeof NodeKind.Thumbnail;
  videoId: string;
  outputDir: string;
  deps: { download: DepName<DownloadResult> };
}

export function thumbnailAction(ffmpeg: MediaProcessor): ActionFunc<ThumbnailParams, string> {
  return async (params, inputs) => {
    const output = `${toVideoDir(params.outputDir, params.videoId)}/thumbnail.jpg`;
    await ffmpeg.cropThumbnail(inputs.download.thumb, output);
    return output;
  };
}

export function addThumbnailNode(
  graph: Graph,
  videoId: string,
  download: NodeRef<DownloadResult>,
  ffmpeg: MediaProcessor,
  outputDir: string,
): NodeRef<string> {
  return addNode(graph, `thumbnail:${videoId}`, "crop-v1", {
    kind: NodeKind.Thumbnail, videoId, outputDir,
    deps: { download: dep(download) },
  } satisfies ThumbnailParams, thumbnailAction(ffmpeg));
}
