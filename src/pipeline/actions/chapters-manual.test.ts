import { describe, expect, test } from "bun:test";

import { CLAUDE_MODEL } from "@/config";
import { callClaude } from "@/ports/claude";
import type { WhisperSegment } from "@/types";

import { buildChapterPrompt, parseChapterResponse } from "./chapter-prompt";

function makeSegment(fromSec: number, toSec: number, text: string): WhisperSegment {
  const fmt = (s: number) => {
    const h = String(Math.floor(s / 3600)).padStart(2, "0");
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
    const sec = String(s % 60).padStart(2, "0");
    return `${h}:${m}:${sec},000`;
  };
  return {
    timestamps: { from: fmt(fromSec), to: fmt(toSec) },
    offsets: { from: fromSec * 1000, to: toSec * 1000 },
    text: ` ${text}`,
  };
}

const segments: WhisperSegment[] = [
  makeSegment(0, 30, "Welcome to the podcast. Today we have a great episode planned."),
  makeSegment(30, 60, "I'm your host and we're going to dive into machine learning."),
  makeSegment(60, 90, "But first, a quick overview of what we'll cover today."),
  makeSegment(90, 120, "Let's start with the basics of neural networks."),
  makeSegment(120, 150, "A neural network is a computational model inspired by the brain."),
  makeSegment(150, 180, "It consists of layers of interconnected nodes."),
  makeSegment(180, 210, "Each connection has a weight that gets adjusted during training."),
  makeSegment(210, 240, "Now let's move on to transformers, a breakthrough architecture."),
  makeSegment(240, 270, "Transformers use self-attention mechanisms."),
  makeSegment(270, 300, "This allows them to process sequences in parallel."),
  makeSegment(300, 330, "The key innovation was the attention is all you need paper."),
  makeSegment(330, 360, "Let's talk about practical applications now."),
  makeSegment(360, 390, "Large language models like GPT are built on transformers."),
  makeSegment(390, 420, "They can generate text, answer questions, and write code."),
  makeSegment(420, 450, "Moving on to computer vision applications."),
  makeSegment(450, 480, "Vision transformers have shown impressive results."),
  makeSegment(480, 510, "They're being used in medical imaging and autonomous driving."),
  makeSegment(510, 540, "Now let's discuss the ethical considerations."),
  makeSegment(540, 570, "Bias in training data is a major concern."),
  makeSegment(570, 600, "We need careful evaluation and diverse datasets."),
  makeSegment(600, 630, "In conclusion, AI is rapidly evolving."),
  makeSegment(630, 660, "Thanks for listening, and we'll see you next time."),
];

describe.skipIf(!process.env.MANUAL_TEST)("manual", () => {
  test("chapter system prompt produces parseable output", async () => {
    const prompt = buildChapterPrompt(segments, "Generate chapters for this podcast transcript.");
    const response = await callClaude(prompt, CLAUDE_MODEL);
    const chapters = parseChapterResponse(response, segments);
    expect(chapters.length).toBeGreaterThan(0);
    for (const ch of chapters) {
      expect(ch.startTime).toBeGreaterThanOrEqual(0);
      expect(typeof ch.title).toBe("string");
      expect(ch.title.length).toBeGreaterThan(0);
    }
  }, 60_000);
});
