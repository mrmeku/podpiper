import type { NodeRef } from "@/dag/types";
import type { TranscribeResult } from "@/ports/types";
import type { WhisperJson, YtDlpInfo } from "@/types";

import { defineAction } from "../define-action";
import type { DownloadResult } from "./download";
import { NodeKind, toVideoActionName } from "./node-kind";

function formatTranscriptForLlm(whisper: WhisperJson): string {
  return whisper.transcription.map((s) => s.text.trim()).join("\n");
}

export interface SummaryParams {
  kind: typeof NodeKind.Summary;
  videoId: string;
  summaryPrompt: string;
  deps: { download: NodeRef<DownloadResult>; transcribe: NodeRef<TranscribeResult> };
}

export const summary = defineAction<SummaryParams, string>({
  name: toVideoActionName,
  config: (p) => {
    const promptHash = Bun.hash(p.summaryPrompt).toString(36);
    return `summary-v2,prompt=${promptHash}`;
  },
  action: (ports) => async (params, inputs) => {
    const info = await ports.fs.readJson<YtDlpInfo>(inputs.download.info);
    const jsonExists = await ports.fs.exists(inputs.transcribe.json);
    if (!jsonExists) return info.description ?? "";
    const whisper = await ports.fs.readJson<WhisperJson>(inputs.transcribe.json);
    if (!whisper.transcription.length) return info.description ?? "";
    const transcript = formatTranscriptForLlm(whisper);
    const prompt = `${params.summaryPrompt}\n\nPlease summarize this episode titled "${info.title}". Here is the transcript:\n\n${transcript}`;
    return ports.claude.call(prompt);
  },
});
