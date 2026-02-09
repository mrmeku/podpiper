import type { NodeRef } from "@/dag/types";
import { toVideoDir } from "@/paths";

import { defineAction } from "../define-action";
import type { DownloadResult } from "./download";
import { NodeKind, toVideoActionName } from "./node-kind";

export interface ThumbnailParams {
  kind: typeof NodeKind.Thumbnail;
  videoId: string;
  outputDir: string;
  deps: { download: NodeRef<DownloadResult> };
}

export const thumbnail = defineAction<ThumbnailParams, string>({
  name: toVideoActionName,
  config: "crop-v1",
  action: (ports) => async (params, inputs) => {
    const outputPath = `${toVideoDir(params.outputDir, params.videoId)}/thumbnail.jpg`;
    await ports.ffmpeg.cropThumbnail(inputs.download.thumb, outputPath);
    return outputPath;
  },
});
