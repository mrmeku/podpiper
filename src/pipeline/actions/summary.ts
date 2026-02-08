import type { Graph } from "@/dag/graph";
import { addNode } from "@/dag/graph";
import { stringRef } from "@/dag/types";
import type { ActionFunc, NodeRef } from "@/dag/types";
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
  deps: { download: string; transcribe: string };
}

export function summaryAction(fs: FileSystem, claude: Llm): ActionFunc<SummaryParams> {
  return async (params, inputs) => {
    const dl: DownloadResult = JSON.parse(inputs.download);
    const tr: TranscribeResult = JSON.parse(inputs.transcribe);
    const info = await fs.readJson<YtDlpInfo>(dl.info);
    const jsonExists = await fs.exists(tr.json);
    if (!jsonExists) return info.description ?? "";
    const whisper = await fs.readJson<WhisperJson>(tr.json);
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
  const name = `summary:${videoId}`;
  const promptHash = Bun.hash(summaryPrompt).toString(36);
  addNode(graph, name, `summary-v2,prompt=${promptHash}`, {
    kind: NodeKind.Summary, summaryPrompt,
    deps: { download: download.name, transcribe: transcribe.name },
  } satisfies SummaryParams, summaryAction(fs, claude));
  return stringRef(name);
}
