import type { NodeRef } from "@/dag/types";

import { NodeKind, defineActionWithPorts, toVideoActionName, toVideoDir } from "./define-action";
import type { DownloadResult } from "./download";

export interface ThumbnailParams {
  kind: typeof NodeKind.Thumbnail;
  videoId: string;
  outputDir: string;
  deps: { download: NodeRef<DownloadResult> };
}

export const thumbnail = defineActionWithPorts<ThumbnailParams, string>({
  name: toVideoActionName,
  config: "crop-v1",
  action: (ports) => async (params, inputs) => {
    const outputPath = `${toVideoDir(params.outputDir, params.videoId)}/thumbnail.jpg`;
    await ports.ffmpeg.cropThumbnail(inputs.download.thumb, outputPath);
    return outputPath;
  },
});
