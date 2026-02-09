import type { NodeRef } from "@/dag/types";
import type { TranscribeResult } from "@/ports/types";
import type { Chapter, WhisperJson, YtDlpChapter } from "@/types";

import { defineAction } from "../define-action";
import { buildChapterPrompt, parseChapterResponse } from "./chapter-prompt";
import type { DownloadResult } from "./download";
import { NodeKind, toVideoActionName } from "./node-kind";

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
  videoId: string;
  chapterPrompt: string | undefined;
  deps: { download: NodeRef<DownloadResult>; transcribe: NodeRef<TranscribeResult> };
}

export const chapters = defineAction<ChaptersParams, Chapter[]>({
  name: toVideoActionName,
  config: (p) => {
    const promptHash = p.chapterPrompt ? Bun.hash(p.chapterPrompt).toString(36) : "none";
    return `extract-v1,fallback=${promptHash}`;
  },
  action: (ports) => async (params, inputs) => {
    const info = await ports.fs.readJson<{ chapters?: YtDlpChapter[] }>(inputs.download.info);
    const chapters = convertYtDlpChapters(info.chapters);
    if (chapters.length > 0) return chapters;
    if (params.chapterPrompt) {
      const jsonExists = await ports.fs.exists(inputs.transcribe.json);
      if (jsonExists) {
        const whisper = await ports.fs.readJson<WhisperJson>(inputs.transcribe.json);
        const prompt = buildChapterPrompt(whisper.transcription, params.chapterPrompt);
        const result = await ports.claude.call(prompt);
        return parseChapterResponse(result, whisper.transcription);
      }
    }
    return [];
  },
});
