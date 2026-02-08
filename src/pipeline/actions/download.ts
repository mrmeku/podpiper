import type { Graph } from "@/dag/graph";
import { jsonRef } from "@/dag/types";
import type { NodeRef } from "@/dag/types";
import { toVideoDir } from "@/paths";
import type { YouTubeDownloader } from "@/ports/types";

import { NodeKind } from "./node-kind";

export interface DownloadResult {
  audio: string;
  info: string;
  thumb: string;
}

export function addDownloadNode(
  graph: Graph,
  videoId: string,
  ytdlp: YouTubeDownloader,
  outputDir: string,
): NodeRef<DownloadResult> {
  const name = `download:${videoId}`;
  const dir = toVideoDir(outputDir, videoId);
  graph.add({
    name,
    kind: NodeKind.Download,
    deps: [],
    config: "ytdlp-v1,quality=0,embed-thumb,embed-chapters",
    action: async () => {
      await ytdlp.downloadVideo(dir, videoId);
      return JSON.stringify({
        audio: `${dir}/audio.mp3`,
        info: `${dir}/audio.info.json`,
        thumb: `${dir}/audio.jpg`,
      } satisfies DownloadResult);
    },
  });
  return jsonRef<DownloadResult>(name);
}
