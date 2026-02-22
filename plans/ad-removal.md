# Ad Removal: Implementation Plan

## Updated DAG

```
download → transcribe → detect_ads → remove_ads → clean_transcript ──→ thumbnail
                                                                   ├──→ chapters
                                                                   ├──→ summary
                                                                   └──→ rss entry
```

Ad detection and removal sit between transcription and all content-generation nodes. Chapters, summary, and any other LLM-derived content receive the cleaned transcript, so their outputs are correct by construction with no timestamp fixup needed.

## Node Specifications

### 1. detect_ads

**Inputs:**

- Whisper transcript (timestamped segments, JSON format)

**Outputs:**

- `ad_segments`: list of `{start_s, end_s, label}`
- `label`: `sponsor`

**Implementation:**

- Single LLM call with the full timestamped transcript
- Prompt asks for JSON array output
- Filter results: drop any detection shorter than `MIN_AD_DURATION_S`
- Merge overlapping or adjacent segments (gap < `AD_PADDING_S * 2`)

**Prompt outline:**

```
You are analyzing a podcast/video transcript to identify sponsored ad reads.

The transcript is provided as timestamped segments:
{transcript_json}

Identify segments where the speaker is reading a paid advertisement for a
third-party product or service. These typically:
- Explicitly name a sponsor ("this video is sponsored by", "thanks to X for sponsoring")
- Include calls to action with promo codes, discount links, or vanity URLs
- Describe product features or offers in a way that breaks from the main topic
- Appear as self-contained blocks that begin and end with clear transitions

For each, return:
{start_s, end_s, label, reason}

Rules:
- Only flag clear sponsored ad reads. When uncertain, do not flag.
- Snap start_s and end_s to the nearest transcript segment boundary.
- Return an empty array if no ads are found.

Respond with a JSON array only, no other text.
```

**Error handling:**

- If LLM output fails to parse as JSON, retry once with a stricter prompt
- If retry fails, pass through the original audio/transcript unchanged (fail open)

### 2. remove_ads

**Inputs:**

- Original audio file
- `ad_segments` from detect_ads

**Outputs:**

- Cleaned audio file
- `time_map`: list of `{original_start, original_end, new_start}` for each kept segment

**Implementation:**

- If `ad_segments` is empty, pass through original audio and identity time_map
- Compute the inverse of ad_segments to get kept regions, applying `AD_PADDING_S` inward on each ad boundary
- Clamp padding so kept regions don't go negative-length
- Use ffmpeg concat demuxer to join kept segments without re-encoding:

```bash
# Extract each kept segment
for i, seg in kept_segments:
    ffmpeg -i input.m4a -ss {seg.start} -to {seg.end} -c copy seg_{i}.m4a

# Build concat list
echo "file 'seg_0.m4a'\nfile 'seg_1.m4a'\n..." > segments.txt

# Concatenate
ffmpeg -f concat -safe 0 -i segments.txt -c copy output.m4a
```

- Build `time_map` by accumulating durations of kept segments:
  - `new_start[0] = 0`
  - `new_start[i] = new_start[i-1] + (kept[i-1].end - kept[i-1].start)`

### 3. clean_transcript

**Inputs:**

- Original whisper segments (JSON)
- `ad_segments` from detect_ads
- `time_map` from remove_ads

**Outputs:**

- Cleaned transcript segments with shifted timestamps

**Implementation:**

- Drop any whisper segment whose midpoint falls within an ad region
- For surviving segments, map timestamps through `time_map`:
  - Find which kept region the segment belongs to
  - `new_ts = time_map[region].new_start + (original_ts - time_map[region].original_start)`
- This is pure data manipulation — no whisper re-run, no LLM call

**Edge case:** A whisper segment that partially overlaps an ad boundary. Using the midpoint rule keeps it simple — the segment is either kept or dropped, never split. Splitting would require re-aligning word boundaries for marginal benefit.

## Config

```python
ENABLE_AD_REMOVAL = True
AD_PADDING_S = 1.0              # padding inward from detected ad edges
MIN_AD_DURATION_S = 10          # ignore very short detections
AD_DETECTION_MODEL = "sonnet"   # model for detection call
```

## Failure Modes

| Failure                        | Behavior                                                                  |
| ------------------------------ | ------------------------------------------------------------------------- |
| LLM returns unparseable output | Retry once, then pass through original (fail open)                        |
| LLM detects no ads             | Pipeline continues with original audio (no-op)                            |
| LLM hallucinates an ad segment | Content is cut — mitigated by `MIN_AD_DURATION_S` and conservative prompt |
| ffmpeg concat fails            | Fail the video, log error, skip to next                                   |
| Whisper segments don't align   | Midpoint rule handles partial overlaps gracefully                         |

The worst failure mode is false positives — cutting real content. The prompt is tuned conservative ("when uncertain, do not flag"), and `MIN_AD_DURATION_S` prevents tiny hallucinated segments from cutting content. If this proves insufficient in practice, add a confidence field to the LLM output and filter by threshold.

## Testing Approach

Before wiring into the full pipeline:

1. Run detect_ads on 10-20 transcripts from channels you know have ads
2. Manually verify the detected segments against the videos
3. Tune the prompt and `MIN_AD_DURATION_S` based on false positive/negative rates
4. Then wire in remove_ads and clean_transcript
