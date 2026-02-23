import type { TranscribeResult } from "@/ports/types";
import type { NodeRef } from "@podpiper/dag/types";

import { NodeKind, defineActionWithPorts, toVideoActionName } from "./define-action";
import type { DownloadResult } from "./download";

export interface TranscribeParams {
  kind: typeof NodeKind.Transcribe;
  videoId: string;
  deps: { download: NodeRef<DownloadResult> };
}

export const transcribe = defineActionWithPorts<TranscribeParams, TranscribeResult>({
  name: toVideoActionName,
  config: "whisper-v1,model=medium",
  action: (ports) => async (_params, inputs, outputDir) => {
    return ports.whisper.transcribe(inputs.download.audio, outputDir);
  },
});
