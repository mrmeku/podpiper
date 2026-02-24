import type { TranscribeResult } from "@/ports/types";
import type { NodeRefOf } from "@podpiper/dagraph";

import { NodeKind, defineActionWithPorts, toVideoActionName } from "./define-action";
import type { download } from "./download";

export interface TranscribeParams {
  kind: typeof NodeKind.Transcribe;
  videoId: string;
  deps: { download: NodeRefOf<download> };
}

export const transcribe = defineActionWithPorts<TranscribeParams, TranscribeResult>({
  name: toVideoActionName,
  config: "whisper-v1,model=medium",
  action: (ports) => async (_params, inputs, outputDir) => {
    return ports.whisper.transcribe(inputs.download.audio, outputDir);
  },
});
export type transcribe = typeof transcribe;
