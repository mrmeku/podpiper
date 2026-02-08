import type { NodeRef } from "@/dag/types";
import { toVideoDir } from "@/paths";
import type { TranscribeResult } from "@/ports/types";

import { defineAction } from "../define-action";
import type { DownloadResult } from "./download";
import { NodeKind } from "./node-kind";

export interface TranscribeParams {
  kind: typeof NodeKind.Transcribe;
  videoId: string;
  outputDir: string;
  deps: { download: NodeRef<DownloadResult> };
}

export const transcribe = defineAction<TranscribeParams, TranscribeResult>({
  name: (p) => `transcribe:${p.videoId}`,
  config: "whisper-v1,model=medium",
  action: (ports) => async (params, inputs) => {
    const dir = toVideoDir(params.outputDir, params.videoId);
    return ports.whisper.transcribe(inputs.download.audio, dir);
  },
});
