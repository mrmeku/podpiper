import type { JsonPath } from "@/typed-path";
import { jsonPath, readJson, readJsonIfExists } from "@/typed-path";
import type { Chapter, ChaptersResult, YtDlpChapter } from "@/types";
import type { NodeRefOf } from "@podpiper/dagraph";

import { buildChapterPrompt, parseChapterResponse } from "./chapter-prompt";
import { NodeKind, defineActionWithPorts } from "./define-action";
import type { download } from "./download";
import type { transcribe } from "./transcribe";

const UNTITLED_PATTERN = /^<Untitled Chapter \d+>$/;

function cleanChapterTitle(title: string, index: number, startTime: number): string {
  if (!UNTITLED_PATTERN.test(title)) return title;
  return startTime === 0 ? "Introduction" : `Chapter ${index + 1}`;
}

function convertYtDlpChapters(chapters?: YtDlpChapter[]): Chapter[] {
  if (!chapters?.length) return [];
  return chapters.map((c, i) => ({
    startTime: c.start_time,
    endTime: c.end_time,
    title: cleanChapterTitle(c.title, i, c.start_time),
  }));
}

export interface ChaptersParams {
  kind: typeof NodeKind.Chapters;
  videoId: string;
  deps: { download: NodeRefOf<download>; transcribe: NodeRefOf<transcribe> };
}

interface ChaptersConfig {
  version: 1;
  prompt: string | undefined;
}

export const chapters = (chapterPrompt: string | undefined) =>
  defineActionWithPorts<ChaptersParams, JsonPath<ChaptersResult>, ChaptersConfig>({
    config: { version: 1, prompt: chapterPrompt },
    action: (ports, config) => async (_params, inputs, outputDir) => {
      const info = await readJson(ports.fs, inputs.download.info);
      const ytChapters = convertYtDlpChapters(info.chapters);
      let result: ChaptersResult = { chapters: ytChapters, generated: false };
      if (ytChapters.length === 0 && config.prompt) {
        const whisper = await readJsonIfExists(ports.fs, inputs.transcribe.json);
        if (whisper) {
          const prompt = buildChapterPrompt(whisper.transcription, config.prompt);
          const llmResult = await ports.claude.call(prompt);
          result = { chapters: parseChapterResponse(llmResult, whisper.transcription), generated: true };
        }
      }
      const outputPath = `${outputDir}/chapters.json`;
      await ports.fs.writeText(outputPath, JSON.stringify(result));
      return jsonPath<ChaptersResult>(outputPath);
    },
  });
export type chapters = typeof chapters;
