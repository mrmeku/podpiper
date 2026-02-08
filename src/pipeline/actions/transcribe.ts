import type { Graph } from "@/dag/graph";
import { addNode } from "@/dag/graph";
import type { ActionFunc, DepName, NodeRef } from "@/dag/types";
import { dep } from "@/dag/types";
import { toVideoDir } from "@/paths";
import type { TranscribeResult, Transcriber } from "@/ports/types";

import type { DownloadResult } from "./download";
import { NodeKind } from "./node-kind";

export interface TranscribeParams {
  kind: typeof NodeKind.Transcribe;
  videoId: string;
  outputDir: string;
  deps: { download: DepName<DownloadResult> };
}

export function transcribeAction(whisper: Transcriber): ActionFunc<TranscribeParams, TranscribeResult> {
  return async (params, inputs) => {
    const dir = toVideoDir(params.outputDir, params.videoId);
    return whisper.transcribe(inputs.download.audio, dir);
  };
}

export function addTranscribeNode(
  graph: Graph,
  videoId: string,
  download: NodeRef<DownloadResult>,
  whisper: Transcriber,
  outputDir: string,
): NodeRef<TranscribeResult> {
  return addNode(graph, `transcribe:${videoId}`, "whisper-v1,model=medium", {
    kind: NodeKind.Transcribe, videoId, outputDir,
    deps: { download: dep(download) },
  } satisfies TranscribeParams, transcribeAction(whisper));
}
