import type { Graph } from "@/dag/graph";
import { addNode } from "@/dag/graph";
import type { ActionFunc, DepName, NodeRef } from "@/dag/types";
import { dep } from "@/dag/types";
import type { FileSystem, Llm, TranscribeResult } from "@/ports/types";
import type { Chapter, WhisperJson, YtDlpChapter } from "@/types";

import { buildChapterPrompt, parseChapterResponse } from "./chapter-prompt";
import type { DownloadResult } from "./download";
import { NodeKind } from "./node-kind";

const UNTITLED_PATTERN = /^<Untitled Chapter \d+>$/;

function cleanChapterTitle(title: string, index: number, startTime: number): string {
  if (!UNTITLED_PATTERN.test(title)) return title;
  return startTime === 0 ? "Introduction" : `Chapter ${index + 1}`;
}

function convertYtDlpChapters(chapters?: YtDlpChapter[]): Chapter[] {
  if (!chapters?.length) return [];
  return chapters.map((c, i) => ({
    startTime: c.start_time,
    title: cleanChapterTitle(c.title, i, c.start_time),
  }));
}

export interface ChaptersParams {
  kind: typeof NodeKind.Chapters;
  chapterPrompt: string | undefined;
  deps: { download: DepName<DownloadResult>; transcribe: DepName<TranscribeResult> };
}

export function chaptersAction(fs: FileSystem, claude: Llm): ActionFunc<ChaptersParams, Chapter[]> {
  return async (params, inputs) => {
    const info = await fs.readJson<{ chapters?: YtDlpChapter[] }>(inputs.download.info);
    const chapters = convertYtDlpChapters(info.chapters);
    if (chapters.length > 0) return chapters;
    if (params.chapterPrompt) {
      const jsonExists = await fs.exists(inputs.transcribe.json);
      if (jsonExists) {
        const whisper = await fs.readJson<WhisperJson>(inputs.transcribe.json);
        const prompt = buildChapterPrompt(whisper.transcription, params.chapterPrompt);
        const result = await claude.call(prompt);
        return parseChapterResponse(result, whisper.transcription);
      }
    }
    return [];
  };
}

export function addChaptersNode(
  graph: Graph,
  videoId: string,
  download: NodeRef<DownloadResult>,
  transcribe: NodeRef<TranscribeResult>,
  fs: FileSystem,
  claude: Llm,
  chapterPrompt: string | undefined,
): NodeRef<Chapter[]> {
  const promptHash = chapterPrompt ? Bun.hash(chapterPrompt).toString(36) : "none";
  return addNode(graph, `chapters:${videoId}`, `extract-v1,fallback=${promptHash}`, {
    kind: NodeKind.Chapters, chapterPrompt,
    deps: { download: dep(download), transcribe: dep(transcribe) },
  } satisfies ChaptersParams, chaptersAction(fs, claude));
}
