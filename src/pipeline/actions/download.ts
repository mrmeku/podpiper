import type { Graph } from "@/dag/graph";
import { addNode } from "@/dag/graph";
import { jsonRef } from "@/dag/types";
import type { ActionFunc, NodeRef } from "@/dag/types";
import { toVideoDir } from "@/paths";
import type { YouTubeDownloader } from "@/ports/types";

import { NodeKind } from "./node-kind";

export interface DownloadResult {
  audio: string;
  info: string;
  thumb: string;
}

export interface DownloadParams {
  kind: typeof NodeKind.Download;
  videoId: string;
  outputDir: string;
}

export function downloadAction(ytdlp: YouTubeDownloader): ActionFunc<DownloadParams> {
  return async (params) => {
    const dir = toVideoDir(params.outputDir, params.videoId);
    await ytdlp.downloadVideo(dir, params.videoId);
    return JSON.stringify({
      audio: `${dir}/audio.mp3`,
      info: `${dir}/audio.info.json`,
      thumb: `${dir}/audio.jpg`,
    } satisfies DownloadResult);
  };
}

export function addDownloadNode(
  graph: Graph,
  videoId: string,
  ytdlp: YouTubeDownloader,
  outputDir: string,
): NodeRef<DownloadResult> {
  const name = `download:${videoId}`;
  addNode(graph, name, "ytdlp-v1,quality=0,embed-thumb,embed-chapters", {
    kind: NodeKind.Download, videoId, outputDir,
  } satisfies DownloadParams, downloadAction(ytdlp));
  return jsonRef<DownloadResult>(name);
}
