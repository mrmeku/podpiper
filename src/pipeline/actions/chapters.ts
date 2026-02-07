import type { Graph } from "@/dag/graph";
import { jsonRef } from "@/dag/types";
import type { NodeRef } from "@/dag/types";
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

export function addChaptersNode(
  graph: Graph,
  videoId: string,
  download: NodeRef<DownloadResult>,
  transcribe: NodeRef<TranscribeResult>,
  fs: FileSystem,
  claude: Llm,
  chapterPrompt: string | undefined,
): NodeRef<Chapter[]> {
  const name = `chapters:${videoId}`;
  const promptHash = chapterPrompt ? Bun.hash(chapterPrompt).toString(36) : "none";
  graph.add({
    name,
    kind: NodeKind.Chapters,
    deps: [download.name, transcribe.name],
    config: `extract-v1,fallback=${promptHash}`,
    action: async (inputs) => {
      const dl = download.parse(inputs[download.name]!);
      const info = await fs.readJson<{ chapters?: YtDlpChapter[] }>(dl.info);
      const chapters = convertYtDlpChapters(info.chapters);
      if (chapters.length > 0) return JSON.stringify(chapters);
      if (chapterPrompt) {
        const tr = transcribe.parse(inputs[transcribe.name]!);
        const jsonExists = await fs.exists(tr.json);
        if (jsonExists) {
          const whisper = await fs.readJson<WhisperJson>(tr.json);
          const prompt = buildChapterPrompt(whisper.transcription, chapterPrompt);
          const result = await claude.call(prompt);
          return JSON.stringify(parseChapterResponse(result, whisper.transcription));
        }
      }
      return JSON.stringify([]);
    },
  });
  return jsonRef<Chapter[]>(name);
}
