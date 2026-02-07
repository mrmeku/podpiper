import type { Graph } from "@/dag/graph";
import { stringRef } from "@/dag/types";
import type { NodeRef } from "@/dag/types";
import type { FileSystem, Llm, TranscribeResult } from "@/ports/types";
import type { WhisperJson, YtDlpInfo } from "@/types";

import type { DownloadResult } from "./download";

function formatTranscriptForLlm(whisper: WhisperJson): string {
  return whisper.transcription.map((s) => s.text.trim()).join("\n");
}

export function addSummaryNode(
  graph: Graph,
  videoId: string,
  download: NodeRef<DownloadResult>,
  transcribe: NodeRef<TranscribeResult>,
  fs: FileSystem,
  claude: Llm,
  summaryPrompt: string,
): NodeRef<string> {
  const name = `summary:${videoId}`;
  const promptHash = Bun.hash(summaryPrompt).toString(36);
  graph.add({
    name,
    deps: [download.name, transcribe.name],
    config: `summary-v2,prompt=${promptHash}`,
    action: async (inputs) => {
      const dl = download.parse(inputs[download.name]!);
      const tr = transcribe.parse(inputs[transcribe.name]!);
      const info = await fs.readJson<YtDlpInfo>(dl.info);
      const jsonExists = await fs.exists(tr.json);
      if (!jsonExists) return info.description ?? "";
      const whisper = await fs.readJson<WhisperJson>(tr.json);
      if (!whisper.transcription.length) return info.description ?? "";
      const transcript = formatTranscriptForLlm(whisper);
      const prompt = `${summaryPrompt}\n\nPlease summarize this episode titled "${info.title}". Here is the transcript:\n\n${transcript}`;
      return claude.call(prompt);
    },
  });
  return stringRef(name);
}
