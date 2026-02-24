import type { NodeRefOf } from "@podpiper/dagraph";

import { NodeKind, defineActionWithPorts, toVideoActionName } from "./define-action";
import type { download } from "./download";

export interface ThumbnailParams {
  kind: typeof NodeKind.Thumbnail;
  videoId: string;
  deps: { download: NodeRefOf<download> };
}

export const thumbnail = defineActionWithPorts<ThumbnailParams, string>({
  name: toVideoActionName,
  config: "crop-v1",
  action: (ports) => async (_params, inputs, outputDir) => {
    const outputPath = `${outputDir}/thumbnail.jpg`;
    await ports.ffmpeg.cropThumbnail(inputs.download.thumb, outputPath);
    return outputPath;
  },
});
