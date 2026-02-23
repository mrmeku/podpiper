import type { TranscribeResult } from "@/ports/types";
import { readJson, readJsonIfExists } from "@/typed-path";
import type { WhisperJson } from "@/types";
import type { NodeRef } from "@podpiper/dagraph";

import { NodeKind, defineActionWithPorts, toVideoActionName } from "./define-action";
import type { DownloadResult } from "./download";

function formatTranscriptForLlm(whisper: WhisperJson): string {
  return whisper.transcription.map((s) => s.text.trim()).join("\n");
}

export interface SummaryParams {
  kind: typeof NodeKind.Summary;
  videoId: string;
  deps: { download: NodeRef<DownloadResult>; transcribe: NodeRef<TranscribeResult> };
}

interface SummaryConfig {
  version: 2;
  prompt: string;
}

export const summary = (summaryPrompt: string) =>
  defineActionWithPorts<SummaryParams, string, SummaryConfig>({
    name: toVideoActionName,
    config: { version: 2, prompt: summaryPrompt },
    action: (ports, config) => async (_params, inputs, outputDir) => {
      const info = await readJson(ports.fs, inputs.download.info);
      let text: string = info.description ?? "";

      const whisper = await readJsonIfExists(ports.fs, inputs.transcribe.json);
      if (whisper && whisper.transcription.length) {
        const transcript = formatTranscriptForLlm(whisper);
        const prompt = `${config.prompt}\n\nPlease summarize this episode titled "${info.title}". Here is the transcript:\n\n${transcript}`;
        text = await ports.claude.call(prompt);
      }

      const outputPath = `${outputDir}/summary.txt`;
      await ports.fs.writeText(outputPath, text);
      return outputPath;
    },
  });
