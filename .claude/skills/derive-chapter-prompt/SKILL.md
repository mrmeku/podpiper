---
name: derive-chapter-prompt
description: Analyze videos with author-provided chapters to reverse-engineer a channel-specific chapter prompt
argument-hint: [channel-name]
---

# Derive Chapter Prompt

Analyze a channel's videos that have author-provided YouTube chapters, reverse-engineer what prompt would have produced those chapters from the transcript, and synthesize a unified channel-specific `chapterPrompt`.

## Arguments

- `channel-name` (required): Key from `src/config.ts` channels record (e.g. `heidi`, `asianometry`)

## Steps

### 1. Validate channel and check data availability

Read `src/config.ts` to confirm the channel exists. Then check that synced data is available:

```bash
ls output/<channel>/videos/
```

If `output/<channel>/videos/` does not exist or is empty, tell the user:

> No synced data found. Run this first:
> ```
> bun src/cli/cli.ts sync <channel> -n 30
> ```
> Then re-run this skill.

### 2. Find videos with author-provided chapters AND transcripts

Scan `output/<channel>/videos/*/audio.info.json` to find videos where the `chapters` array is non-empty. Also verify each video has a whisper transcript at `output/<channel>/videos/<videoId>/audio.json`.

Read each candidate's `audio.info.json` and collect: videoId, title, duration, chapter count, and the chapters themselves.

From the candidates, select up to 8 videos. Prioritize diversity:
- Include videos of different durations (short ~10min, medium ~20-30min, long ~45min+)
- Include videos with different chapter counts
- Exclude very short videos (<5 min)

Present the selected videos to the user with AskUserQuestion, listing each with title, duration, and chapter count.

### 3. Reverse-engineer prompts (parallel subagents)

For each selected video, launch a Task subagent (subagent_type: "general-purpose"). Run all subagents in parallel in a single message.

Each subagent receives the video's `audio.info.json` chapters and `audio.json` transcript. Provide the subagent with:

- The video title and duration
- The author's chapters formatted as `[MM:SS] Title` (convert `start_time` seconds to MM:SS)
- The transcript formatted as `[0] text\n[1] text\n...` — read `audio.json`, access the `transcription` array, and for each segment use its `.text` field trimmed, prefixed with the segment index. This matches `formatSegmentsForLlm` in `src/pipeline/actions/chapter-prompt.ts`.

Use this prompt template for each subagent (fill in the video-specific data):

```
You are analyzing how a YouTube creator structures their video chapters to reverse-engineer a channel-specific chapter prompt.

CONTEXT: A podcast tool generates chapters from transcripts using an LLM. The LLM receives a minimal framing prompt plus a channel-specific prompt that provides ALL editorial guidance. Your job is to figure out what that channel-specific guidance should say, based on this example of the creator's actual chapters.

The channel-specific prompt must be fully self-contained — it must include guidance on:
- When to skip chapters entirely (return empty [])
- How many chapters to target relative to video length
- Title style and length
- What constitutes a chapter boundary for this creator
- Any special section patterns (intros, sponsor reads, etc.)

VIDEO: "<video_title>" (<duration_minutes> minutes)

AUTHOR'S CHAPTERS:
<formatted chapters>

TRANSCRIPT (numbered segments — same format the chapter generator receives):
<formatted transcript>

Analyze and return these sections:
- PATTERN: One-line description of this video's structural pattern
- BOUNDARY_LOGIC: How chapter boundaries are determined in this video
- TITLE_STYLE: How chapter titles are written (length, specificity, naming convention)
- CHAPTER_DENSITY: How many chapters relative to duration, and whether it's content-driven or time-driven
- SPECIAL_SECTIONS: Any special sections (intro, outro, sponsor, etc.) and how they're handled
- KEY_OBSERVATIONS: 2-3 bullet points about what makes this creator's chaptering distinctive
```

For very long transcripts (>2000 segments), truncate to the first 1000 and last 500 segments with a `[... N segments omitted ...]` note. The structural patterns are visible from representative portions.

### 4. Synthesize into a unified chapter prompt

Once all per-video analyses are collected, launch a single Task subagent (subagent_type: "general-purpose") to synthesize them.

Read `src/config.ts` to get the Heidi channel's `chapterPrompt` as a format calibration example. Also note the minimal template from `src/pipeline/actions/chapter-prompt.ts`:

```
You are a podcast chapter generator. Given numbered transcript segments from a YouTube video, identify chapter breaks.

{{channel_prompt}}

Return ONLY a JSON array, no other text:
[{"segment": 0, "title": "Introduction"}, {"segment": 15, "title": "Topic Name"}]
```

Use this prompt for the synthesis subagent:

```
You are synthesizing multiple per-video chapter analyses into a single, unified channel-specific chapter prompt.

CONTEXT: This prompt fills the {{channel_prompt}} slot in a minimal template that only provides task framing ("You are a podcast chapter generator...") and output format (JSON array). The channel prompt must be FULLY SELF-CONTAINED — it is the sole source of editorial guidance.

The prompt must cover:
- When to return an empty array [] (skip chapters)
- General rules: first chapter at segment 0, title style, what constitutes a chapter boundary
- Recurring video structure patterns with specific chaptering rules for each
- Channel-specific rules and edge cases

HERE IS AN EXAMPLE of a well-written channel prompt for a different channel:

"""
<insert Heidi's chapterPrompt from config.ts>
"""

Notice the structure: CHANNEL, CONTENT TYPE, WHEN TO SKIP, GENERAL RULES, VIDEO STRUCTURE PATTERNS (numbered with specific rules), CHANNEL-SPECIFIC RULES (bulleted).

PER-VIDEO ANALYSES:
<insert all collected analyses, each prefixed with video title and duration>

INSTRUCTIONS:
1. Identify the 2-4 recurring VIDEO STRUCTURE PATTERNS across all analyzed videos. Name each pattern and describe how to chapter it.
2. Determine CHANNEL-SPECIFIC RULES — things specific to this creator's style.
3. Include WHEN TO SKIP and GENERAL RULES sections.
4. Write in the same format as the example.
5. Be specific and actionable — every sentence must tell the LLM something it couldn't infer on its own.
6. Keep it concise: ~150-300 words.

OUTPUT: Return ONLY the channel-specific prompt text. No wrapping, no explanation. This text will be inserted directly as the chapterPrompt config value.
```

### 5. Present the result

Show the synthesized prompt to the user in a code block. Then use AskUserQuestion to ask:

- **Write to config** — add/replace the `chapterPrompt` field in the channel's entry in `src/config.ts`
- **Edit first** — let the user request changes before writing
- **Discard** — discard and optionally retry with different videos

### 6. Write to config (if approved)

Update the channel entry in `src/config.ts` by adding or replacing the `chapterPrompt` field. Use a template literal (backtick-quoted) for multi-line strings, matching the existing Heidi pattern.

Run `bunx tsgo` to verify the change type-checks.
