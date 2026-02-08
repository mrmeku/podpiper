import type { Graph } from "@/dag/graph";
import { addNode } from "@/dag/graph";
import { jsonRef } from "@/dag/types";
import type { ActionFunc, NodeRef } from "@/dag/types";
import { toVideoDir } from "@/paths";
import type { TranscribeResult, Transcriber } from "@/ports/types";

import type { DownloadResult } from "./download";
import { NodeKind } from "./node-kind";

export interface TranscribeParams {
  kind: typeof NodeKind.Transcribe;
  videoId: string;
  outputDir: string;
  deps: { download: string };
}

export function transcribeAction(whisper: Transcriber): ActionFunc<TranscribeParams> {
  return async (params, inputs) => {
    const dl: DownloadResult = JSON.parse(inputs.download);
    const dir = toVideoDir(params.outputDir, params.videoId);
    return JSON.stringify(await whisper.transcribe(dl.audio, dir));
  };
}

export function addTranscribeNode(
  graph: Graph,
  videoId: string,
  download: NodeRef<DownloadResult>,
  whisper: Transcriber,
  outputDir: string,
): NodeRef<TranscribeResult> {
  const name = `transcribe:${videoId}`;
  addNode(graph, name, "whisper-v1,model=medium", {
    kind: NodeKind.Transcribe, videoId, outputDir,
    deps: { download: download.name },
  } satisfies TranscribeParams, transcribeAction(whisper));
  return jsonRef<TranscribeResult>(name);
}
