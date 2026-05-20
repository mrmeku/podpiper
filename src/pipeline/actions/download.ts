import type { Ports } from "@/ports/types";
import type { JsonPath } from "@/typed-path";
import { jsonPath, readJson } from "@/typed-path";
import type { YtDlpInfo } from "@/types";

import { NodeKind, defineActionWithPorts } from "./define-action";

export interface DownloadParams {
  kind: typeof NodeKind.Download;
  videoId: string;
}

export const DURATION_TOLERANCE_SECONDS = 2;

export async function validateDownloadDuration(
  ports: Pick<Ports, "fs" | "ffmpeg">,
  audioPath: string,
  infoPath: JsonPath<YtDlpInfo>,
): Promise<void> {
  const info = await readJson(ports.fs, infoPath);
  if (info.duration === undefined) return;
  const actual = await ports.ffmpeg.probeDuration(audioPath);
  const delta = Math.abs(actual - info.duration);
  if (delta > DURATION_TOLERANCE_SECONDS) {
    throw new Error(
      `Audio duration mismatch for ${info.id}: info.json=${info.duration}s, ffprobe=${actual}s (delta=${delta.toFixed(2)}s > ${DURATION_TOLERANCE_SECONDS}s)`,
    );
  }
}

export const download = defineActionWithPorts<DownloadParams, {
  audio: string;
  info: JsonPath<YtDlpInfo>;
  thumb: string;
}>({
  config: "ytdlp-v1,quality=0,embed-thumb,embed-chapters",
  action: (ports) => async (params, _inputs, outputDir) => {
    await ports.ytdlp.downloadAudio(outputDir, params.videoId);
    const audio = `${outputDir}/audio.mp3`;
    const info = jsonPath<YtDlpInfo>(`${outputDir}/audio.info.json`);
    await validateDownloadDuration(ports, audio, info);
    return { audio, info, thumb: `${outputDir}/audio.jpg` };
  },
});
export type download = typeof download;
