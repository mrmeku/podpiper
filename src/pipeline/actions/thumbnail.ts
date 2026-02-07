import type { Graph } from "@/dag/graph";
import { stringRef } from "@/dag/types";
import type { NodeRef } from "@/dag/types";
import { toVideoDir } from "@/paths";
import type { MediaProcessor } from "@/ports/types";

import type { DownloadResult } from "./download";
import { NodeKind } from "./node-kind";

export function addThumbnailNode(
  graph: Graph,
  videoId: string,
  download: NodeRef<DownloadResult>,
  ffmpeg: MediaProcessor,
  outputDir: string,
): NodeRef<string> {
  const name = `thumbnail:${videoId}`;
  const output = `${toVideoDir(outputDir, videoId)}/thumbnail.jpg`;
  graph.add({
    name,
    kind: NodeKind.Thumbnail,
    deps: [download.name],
    config: "crop-v1",
    action: async (inputs) => {
      const dl = download.parse(inputs[download.name]!);
      await ffmpeg.cropThumbnail(dl.thumb, output);
      return output;
    },
  });
  return stringRef(name);
}
