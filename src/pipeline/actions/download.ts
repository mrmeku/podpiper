import type { JsonPath } from "@/typed-path";
import { jsonPath } from "@/typed-path";
import type { YtDlpInfo } from "@/types";

import { NodeKind, defineActionWithPorts, toVideoActionName } from "./define-action";

export type DownloadResult = {
  audio: string;
  info: JsonPath<YtDlpInfo>;
  thumb: string;
};

export interface DownloadParams {
  kind: typeof NodeKind.Download;
  videoId: string;
}

export const download = defineActionWithPorts<DownloadParams, DownloadResult>({
  name: toVideoActionName,
  config: "ytdlp-v1,quality=0,embed-thumb,embed-chapters",
  action: (ports) => async (params, _inputs, outputDir) => {
    await ports.ytdlp.downloadVideo(outputDir, params.videoId);
    return {
      audio: `${outputDir}/audio.mp3`,
      info: jsonPath<YtDlpInfo>(`${outputDir}/audio.info.json`),
      thumb: `${outputDir}/audio.jpg`,
    };
  },
});
