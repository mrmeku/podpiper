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

Derive a short key from the channel name (lowercase, no spaces, e.g. `heidipriebe` or `asianometry`). Present the derived key to the user with AskUserQuestion for confirmation, allowing them to override it.

### 2. Determine Apple Podcasts category

Search the web for information about what the YouTube channel covers (e.g. `"<channel name>" YouTube channel`). Based on the channel's content, suggest an appropriate category and subcategory from the `ApplePodcastCategory` type defined in `src/types.ts`.

Present your suggestion to the user with AskUserQuestion, offering 2-3 category/subcategory options that seem like good fits.

### 3. Ask about chapter and summary prompts

Use AskUserQuestion to ask whether the user wants to provide custom `chapterPrompt` and `summaryPrompt` strings for this channel. These are optional — if omitted, the channel will use default behavior. Show the user the existing `heidi` channel as an example of a channel with custom prompts.

### 4. Ask about startDate

Use AskUserQuestion to ask whether the user wants to set a `startDate` (YYYYMMDD format) to avoid backfilling the channel's entire history. Suggest today's date as the default. If the user wants the last N videos instead, run `yt-dlp --flat-playlist --print "%(upload_date)s" --playlist-items N "<CHANNEL_URL>/videos"` to determine the appropriate date.

### 5. Add the channel to src/config.ts

Add a new entry to the `channels` record in `src/config.ts`, following the existing pattern. The entry type is `ChannelDef` (`Omit<Config, "outputDir" | "casBaseDir">`).

Required fields:
- `channelUrl`: The YouTube channel URL
- `storage`: `{ bucket: "<key>", publicUrl: "https://<key>.cast.mrmeku.com" }` — derived automatically from the key
- `podcast`: Title, author, description, category, copyright

Optional fields (only include if the user provided them):
- `chapterPrompt`, `summaryPrompt`
- `startDate`

### 6. Provision R2 infrastructure

Run the provisioning script to create the R2 bucket and set up the custom domain:

```bash
bun run scripts/add-channel.ts <key>
```

### 7. Type-check

Run `bunx tsgo` to verify the new entry type-checks correctly.
