import type { JsonPath } from "@/typed-path";
import { jsonPath } from "@/typed-path";
import type { YtDlpInfo } from "@/types";

import { NodeKind, defineActionWithPorts } from "./define-action";

export interface DownloadParams {
  kind: typeof NodeKind.Download;
  videoId: string;
}

export const download = defineActionWithPorts<DownloadParams, {
  audio: string;
  info: JsonPath<YtDlpInfo>;
  thumb: string;
}>({
  config: "ytdlp-v1,quality=0,embed-thumb,embed-chapters",
  action: (ports) => async (params, _inputs, outputDir) => {
    await ports.ytdlp.downloadAudio(outputDir, params.videoId);
    return {
      audio: `${outputDir}/audio.mp3`,
      info: jsonPath<YtDlpInfo>(`${outputDir}/audio.info.json`),
      thumb: `${outputDir}/audio.jpg`,
    };
  },
});
export type download = typeof download;
