import type { Graph } from "@/dag/graph";
import { addNode } from "@/dag/graph";
import { stringRef } from "@/dag/types";
import type { ActionFunc, NodeRef } from "@/dag/types";
import { toVideoDir } from "@/paths";
import type { MediaProcessor } from "@/ports/types";

import type { DownloadResult } from "./download";
import { NodeKind } from "./node-kind";

export interface ThumbnailParams {
  kind: typeof NodeKind.Thumbnail;
  videoId: string;
  outputDir: string;
  deps: { download: string };
}

export function thumbnailAction(ffmpeg: MediaProcessor): ActionFunc<ThumbnailParams> {
  return async (params, inputs) => {
    const dl: DownloadResult = JSON.parse(inputs.download);
    const output = `${toVideoDir(params.outputDir, params.videoId)}/thumbnail.jpg`;
    await ffmpeg.cropThumbnail(dl.thumb, output);
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
  const name = `thumbnail:${videoId}`;
  addNode(graph, name, "crop-v1", {
    kind: NodeKind.Thumbnail, videoId, outputDir,
    deps: { download: download.name },
  } satisfies ThumbnailParams, thumbnailAction(ffmpeg));
  return stringRef(name);
}
