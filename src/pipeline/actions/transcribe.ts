import type { TranscribeResult } from "@/ports/types";
import type { NodeRefOf } from "@podpiper/dagraph";

import { NodeKind, defineActionWithPorts } from "./define-action";
import type { download } from "./download";

export interface TranscribeParams {
  kind: typeof NodeKind.Transcribe;
  videoId: string;
  deps: { download: NodeRefOf<download> };
}

export const transcribe = defineActionWithPorts<TranscribeParams, TranscribeResult>({
  config: "whisper-v1,model=large-v3-turbo",
  concurrencyGroup: "whisper",
  action: (ports) => async (_params, inputs, outputDir) => {
    return ports.whisper.transcribe(inputs.download.audio, outputDir);
  },
});
export type transcribe = typeof transcribe;
