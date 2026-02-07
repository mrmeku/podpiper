import type { Chapter, WhisperSegment } from "@/types";

const CHAPTER_PROMPT_TEMPLATE = `You are a podcast chapter generator. Given numbered transcript segments from a YouTube video, decide whether chapters are appropriate and, if so, identify the major structural breaks.

DECISION: SHOULD THIS VIDEO HAVE CHAPTERS?
Return an empty array [] if ANY of these apply:
- The video is under ~5 minutes of content
- The video covers a single topic throughout with no meaningful shifts
- The video is a short reaction, announcement, or Q&A with rapid topic switching where chapters would not aid navigation
- The transcript is too fragmented or incoherent to chapter reliably

CHAPTER GUIDELINES:
- Chapters mark MAJOR structural shifts, not minor subtopic drift. Think "sections of a book" not "paragraphs."
- Target 3-7 chapters for a typical 30-90 minute video. Fewer for shorter videos. Rarely exceed 8.
- The first chapter MUST start at segment 0.
- Titles: 2-6 words, descriptive of what the section is ABOUT (not what happens, e.g. "AI Safety Concerns" not "They Talk About AI").
- Ads, sponsor reads, and promotions SHOULD get their own chapter (title: "Sponsor" or "Ad Break") so listeners can skip them.

{{channel_prompt}}

Return ONLY a JSON array, no other text:
[{"segment": 0, "title": "Introduction"}, {"segment": 15, "title": "Topic Name"}]`;

export function formatSegmentsForLlm(segments: WhisperSegment[]): string {
  return segments.map((s, i) => `[${i}] ${s.text.trim()}`).join("\n");
}

export function buildChapterPrompt(
  segments: WhisperSegment[],
  channelPrompt: string,
): string {
  const formatted = formatSegmentsForLlm(segments);
  const systemPrompt = CHAPTER_PROMPT_TEMPLATE.replace(
    "{{channel_prompt}}",
    channelPrompt,
  );
  return `${systemPrompt}\n\n${formatted}`;
}

interface ChapterEntry {
  segment: number;
  title: string;
}

export function parseChapterResponse(
  response: string,
  segments: WhisperSegment[],
): Chapter[] {
  try {
    const cleaned = response
      .replace(/```(?:json)?\s*/g, "")
      .replace(/```/g, "")
      .trim();
    const parsed: ChapterEntry[] = JSON.parse(cleaned);
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
