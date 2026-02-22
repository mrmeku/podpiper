import type { JsonPath } from "@/typed-path";
import { jsonPath } from "@/typed-path";
import type { YtDlpInfo } from "@/types";

import { NodeKind, defineActionWithPorts, toVideoActionName, toVideoDir } from "./define-action";

export type DownloadResult = {
  audio: string;
  info: JsonPath<YtDlpInfo>;
  thumb: string;
};

export interface DownloadParams {
  kind: typeof NodeKind.Download;
  videoId: string;
  outputDir: string;
}

export const download = defineActionWithPorts<DownloadParams, DownloadResult>({
  name: toVideoActionName,
  config: "ytdlp-v1,quality=0,embed-thumb,embed-chapters",
  action: (ports) => async (params) => {
    const dir = toVideoDir(params.outputDir, params.videoId);
    await ports.ytdlp.downloadVideo(dir, params.videoId);
    return {
      audio: `${dir}/audio.mp3`,
      info: jsonPath<YtDlpInfo>(`${dir}/audio.info.json`),
      thumb: `${dir}/audio.jpg`,
    };
  },
});
