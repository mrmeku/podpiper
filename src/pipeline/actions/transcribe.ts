import type { Graph } from "@/dag/graph";
import { jsonRef } from "@/dag/types";
import type { NodeRef } from "@/dag/types";
import { toVideoDir } from "@/paths";
import type { TranscribeResult, Transcriber } from "@/ports/types";

import type { DownloadResult } from "./download";
import { NodeKind } from "./node-kind";

export function addTranscribeNode(
  graph: Graph,
  videoId: string,
  download: NodeRef<DownloadResult>,
  whisper: Transcriber,
  outputDir: string,
): NodeRef<TranscribeResult> {
  const name = `transcribe:${videoId}`;
  const dir = toVideoDir(outputDir, videoId);
  graph.add({
    name,
    kind: NodeKind.Transcribe,
    deps: [download.name],
    config: "whisper-v1,model=medium",
    action: async (inputs) => {
      const dl = download.parse(inputs[download.name]!);
      const result = await whisper.transcribe(dl.audio, dir);
      return JSON.stringify(result);
    },
  });
  return jsonRef<TranscribeResult>(name);
}
