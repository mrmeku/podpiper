---
name: add-channel
description: Add a new YouTube channel as a podcast RSS feed
argument-hint: [youtube-channel-url]
---

# Add YouTube Channel

Add a new YouTube channel to this podcast RSS project. The user provides a YouTube channel URL as the argument.

## Steps

### 1. Gather channel metadata

Run this to get the channel name:

```bash
yt-dlp --print "%(playlist_uploader)s" --flat-playlist --playlist-items 1 "<CHANNEL_URL>/videos"
```

Derive a short key from the channel name (lowercase, no spaces, e.g. `heidipriebe` or `asianometry`). Confirm the key with the user.

### 2. Determine Apple Podcasts category

Search the web for information about what the YouTube channel covers (e.g. `"<channel name>" YouTube channel`). Based on the channel's content, suggest an appropriate category and subcategory from the `ApplePodcastCategory` type defined in `src/types.ts`.

Present your suggestion to the user with AskUserQuestion, offering 2-3 category/subcategory options that seem like good fits.

### 3. Ask for R2 bucket configuration

Use AskUserQuestion to ask the user for:

- The R2 bucket name (suggest `<key>` as default, matching existing pattern)
- The R2 public URL (existing pattern: `https://<key>.cast.mrmeku.com`)

### 4. Ask about chapter and summary prompts

Use AskUserQuestion to ask whether the user wants to provide custom `chapterPrompt` and `summaryPrompt` strings for this channel. These are optional — if omitted, the channel will use default behavior. Show the user the existing `heidi` channel as an example of a channel with custom prompts.

### 5. Add the channel to src/config.ts

Add a new entry to the `channels` record in `src/config.ts`, following the existing pattern. The entry type is `ChannelDef` (`Omit<Config, "outputDir">`), which requires `channelUrl`, `r2`, and `podcast`, and optionally accepts `chapterPrompt` and `summaryPrompt`. Only include the optional prompt fields if the user provided them.

### 6. Type-check

Run `bunx tsgo` to verify the new entry type-checks correctly.
