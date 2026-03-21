import type { Config } from "./types";

export type ChannelDef = Omit<Config, "outputDir" | "casBaseDir">;

export const channels: Record<string, ChannelDef> = {
  heidi: {
    channelUrl: "https://www.youtube.com/@heidipriebe1/videos",
    chapterPrompt: `CHANNEL: Heidi Priebe
CONTENT TYPE: Long-form psychology/attachment theory monologues (15-60+ min)

WHEN TO SKIP CHAPTERS (return empty array []):
- Video is under ~5 minutes or is a short announcement
- Transcript is too fragmented to chapter reliably

GENERAL RULES:
- The first chapter MUST start at segment 0.
- Titles: 2-5 word noun phrases that name the concept, not the argument. Think margin notes, not sentences. "Insecure attachment systems" not "Why insecure attachment causes problems".
- Chapter count is a dependent variable — it equals the number of major structural moves the speaker makes. Never target a count or duration.
- Mirror the speaker's own vocabulary and register in titles.

VIDEO STRUCTURE PATTERNS:
1. NUMBERED LIST VIDEOS (e.g. "10 Signs...", "5 Reasons..."): Each numbered item is a chapter. Title with the bare concept name, not the number. Thematically adjacent items may be grouped into one chapter if the speaker treats them as a unit.

2. CONCEPT EXPLORATION VIDEOS (e.g. "Emotional Sobriety: What It Is..."): Chapters track the structural skeleton — definition, distinction, mechanism, steps. One chapter per high-level phase. Sub-points and examples stay inside their parent chapter. Typically 5-10 chapters.

3. TECHNIQUE TOOLKIT VIDEOS (e.g. "How To Metabolize Emotional Pain"): Problem framing → mechanism → enumerated techniques → reframe. Each individual technique or practice step gets its own chapter even if under 60 seconds.

CHANNEL-SPECIFIC RULES:
- Long intros (up to 8 minutes of framing) are left as a single "Intro" chapter — do not split them.
- Personal motivation sections before main content are a separate chapter ("Why I made this video", "My experience with...").
- Self-promotional segments get a neutral descriptive label (e.g. "New Self Resource").
- No sponsor reads to expect. Rarely has an explicit outro — if closing thoughts are substantive, chapter them by topic, not as "Outro".
- When the speaker explicitly enumerates questions or steps, title each chapter near-verbatim from how she names it.`,
    summaryPrompt: `Write a one-paragraph summary (3-5 sentences) of this content for display as a podcast episode description. Summarize what the video covers — the main topic and the general arc of the discussion. Mention the most important ideas without trying to be exhaustive. Write in present tense as appropriate. Be plain and informative — no rhetorical questions, no "in this video", no marketing language, no calls to action. Do not reference the creator by name or role — summarize the content itself, not who is presenting it.`,
    storage: {
      bucket: "heidipriebe",
      publicUrl: "https://heidipriebe.cast.mrmeku.com",
    },
    podcast: {
      title: "Heidi Priebe",
      author: "Heidi Priebe",
      description: "Audio from Heidi Priebe's YouTube channel",
      category: "Education",
      subcategory: "Self-Improvement",
      copyright: "Heidi Priebe",
    },
  },
  atrioc: {
    channelUrl: "https://www.youtube.com/channel/UCdBXOyqr8cDshsp7kcKDAkg/videos",
    startDate: "20260318",
    storage: {
      bucket: "atrioc",
      publicUrl: "https://atrioc.cast.mrmeku.com",
    },
    podcast: {
      title: "Big A",
      author: "Atrioc",
      description: "Audio from Big A's YouTube channel",
      category: "News",
      subcategory: "News Commentary",
      copyright: "Atrioc",
    },
  },
  asianometry: {
    channelUrl: "https://www.youtube.com/asianometry",
    storage: {
      bucket: "asianometry",
      publicUrl: "https://asianometry.cast.mrmeku.com",
    },
    podcast: {
      title: "Asianometry",
      author: "Asianometry",
      description: "Audio from Asianometry's YouTube channel",
      category: "Education",
      copyright: "Asianometry",
    },
  },
};

export function getConfig(name: string): Config {
  const def = channels[name];
  if (!def) {
    const available = Object.keys(channels).join(", ");
    throw new Error(`Unknown channel "${name}". Available: ${available}`);
  }
  const outputDir = `./output/${name}`;
  return { ...def, outputDir, casBaseDir: `${outputDir}/cas` };
}
