import type { Config } from "./types";

export const CLAUDE_MODEL = "sonnet";
export const WHISPER_MODEL_PATH = `${process.env.HOME}/.whisper-models/ggml-medium.bin`;

type ChannelDef = Omit<Config, "outputDir">;

const channels: Record<string, ChannelDef> = {
  heidi: {
    channelUrl: "https://www.youtube.com/@heidipriebe1/videos",
    chapterPrompt: `CHANNEL: Heidi Priebe
CONTENT TYPE: Long-form psychology/attachment theory monologues (typically 15-60 min, some 1hr+)

VIDEO STRUCTURE PATTERNS:
1. NUMBERED LIST VIDEOS (e.g. "10 Signs You May Have...", "5 Reasons..."): She explicitly numbers her points. Each numbered point is a chapter. Use her numbering as chapter boundaries — title each chapter with the point's core idea, NOT "Sign #3" or "Point 5". Example: "Difficulty Trusting Closeness" not "Sign 3".

2. CONCEPT EXPLORATION VIDEOS (e.g. "Limerence: What It Is And How Do We Let It Go", "Toxic Shame: What It Is And How To Heal From It"): She typically defines a concept, explains its causes/origins, then offers healing approaches or practical steps. Chapter at each of these major phases — usually 3-5 chapters total.

3. DEEP DIVES / EXTENDED TALKS (1hr+): These may combine multiple structures. Chapter at each major conceptual shift. Aim for 4-7 chapters.

CHANNEL-SPECIFIC RULES:
- She rarely does sponsor reads — do not expect ad breaks.
- She often has a substantial intro where she frames the topic and gives context before diving in. This intro is its own chapter only if it's notably distinct from the main content (e.g. she recaps last month's theme). Otherwise absorb it into the first content chapter.
- Her videos almost always warrant chapters — return an empty array only for shorts or very brief announcements.
- For numbered-list videos, the chapter count should match her numbering. This is an exception to the typical 3-7 cap.`,
    summaryPrompt: `Write a one-paragraph summary (3-5 sentences) of this content for display as a podcast episode description. Summarize what the video covers — the main topic and the general arc of the discussion. Mention the most important ideas without trying to be exhaustive. Write in present tense as appropriate. Be plain and informative — no rhetorical questions, no "in this video", no marketing language, no calls to action. Do not reference the creator by name or role — summarize the content itself, not who is presenting it.`,
    r2: {
      bucket: "heidipriebe",
      publicUrl: "https://heidipriebe.cast.mrmeku.com",
    },
    podcast: {
      title: "Heidi Priebe",
      author: "Heidi Priebe",
      description: "Audio from Heidi Priebe's YouTube channel",
      category: "Education",
      subcategory: "Self-Improvement",
    },
  },
  asianometry: {
    channelUrl: "https://www.youtube.com/asianometry",
    r2: {
      bucket: "asianometry",
      publicUrl: "https://asianometry.cast.mrmeku.com",
    },
    podcast: {
      title: "Asianometry",
      author: "Asianometry",
      description: "Audio from Asianometry's YouTube channel",
      category: "Education",
    },
  },
};

export function getConfig(name: string): Config {
  const def = channels[name];
  if (!def) {
    const available = Object.keys(channels).join(", ");
    throw new Error(`Unknown channel "${name}". Available: ${available}`);
  }
  return { ...def, outputDir: `./output/${name}` };
}
