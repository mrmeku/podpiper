import type { Graph } from "@/dag/graph";
import { addNode } from "@/dag/graph";
import type { ActionFunc, DepName, NodeRef } from "@/dag/types";
import { dep } from "@/dag/types";
import type { FileSystem, Llm, TranscribeResult } from "@/ports/types";
import type { WhisperJson, YtDlpInfo } from "@/types";

import type { DownloadResult } from "./download";
import { NodeKind } from "./node-kind";

function formatTranscriptForLlm(whisper: WhisperJson): string {
  return whisper.transcription.map((s) => s.text.trim()).join("\n");
}

export interface SummaryParams {
  kind: typeof NodeKind.Summary;
  summaryPrompt: string;
  deps: { download: DepName<DownloadResult>; transcribe: DepName<TranscribeResult> };
}

export function summaryAction(fs: FileSystem, claude: Llm): ActionFunc<SummaryParams, string> {
  return async (params, inputs) => {
    const info = await fs.readJson<YtDlpInfo>(inputs.download.info);
    const jsonExists = await fs.exists(inputs.transcribe.json);
    if (!jsonExists) return info.description ?? "";
    const whisper = await fs.readJson<WhisperJson>(inputs.transcribe.json);
    if (!whisper.transcription.length) return info.description ?? "";
    const transcript = formatTranscriptForLlm(whisper);
    const prompt = `${params.summaryPrompt}\n\nPlease summarize this episode titled "${info.title}". Here is the transcript:\n\n${transcript}`;
    return claude.call(prompt);
  };
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
  const promptHash = Bun.hash(summaryPrompt).toString(36);
  return addNode(graph, `summary:${videoId}`, `summary-v2,prompt=${promptHash}`, {
    kind: NodeKind.Summary, summaryPrompt,
    deps: { download: dep(download), transcribe: dep(transcribe) },
  } satisfies SummaryParams, summaryAction(fs, claude));
}
