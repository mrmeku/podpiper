import type { Chapter, WhisperSegment } from "@/types";
import { jsonParse } from "@podpiper/dag/helpers";

const CHAPTER_PROMPT_TEMPLATE = `You are a podcast chapter generator. Given numbered transcript segments from a YouTube video, identify chapter breaks.

{{channel_prompt}}

Return ONLY a JSON array, no other text:
[{"segment": 0, "title": "Introduction"}, {"segment": 15, "title": "Topic Name"}]`;

export function formatSegmentsForLlm(segments: WhisperSegment[]): string {
  return segments.map((s, i) => `[${i}] ${s.text.trim()}`).join("\n");
}

export function buildChapterPrompt(segments: WhisperSegment[], channelPrompt: string): string {
  const formatted = formatSegmentsForLlm(segments);
  const systemPrompt = CHAPTER_PROMPT_TEMPLATE.replace("{{channel_prompt}}", channelPrompt);
  return `${systemPrompt}\n\n${formatted}`;
}

interface ChapterEntry {
  segment: number;
  title: string;
}

export function parseChapterResponse(response: string, segments: WhisperSegment[]): Chapter[] {
  try {
    const cleaned = response
      .replace(/```(?:json)?\s*/g, "")
      .replace(/```/g, "")
      .trim();
    const parsed = jsonParse<ChapterEntry[]>(cleaned, "chapter LLM response");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (e) =>
          typeof e.segment === "number" &&
          typeof e.title === "string" &&
          e.segment >= 0 &&
          e.segment < segments.length,
      )
      .map((e) => ({
        startTime: segments[e.segment]!.offsets.from / 1000,
        title: e.title,
      }));
  } catch {
    return [];
  }
}
