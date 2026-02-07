import { $ } from "bun";

import type { YouTubeDownloader } from "./types";

const PRINT_FMT = "%(id)s|%(upload_date)s|%(title)s";

export function createRealYtdlp(opts?: { force?: boolean }): YouTubeDownloader {
  const force = opts?.force ?? false;
  return {
    fetchVideoList: async (channelUrl) => {
      const output = await $`yt-dlp --flat-playlist --print ${PRINT_FMT} ${channelUrl}`
        .quiet()
        .text();
      return output
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => {
          const parts = line.split("|");
          if (parts.length < 3) throw new Error(`Malformed yt-dlp output: ${line}`);
          return { id: parts[0]!, uploadDate: parts[1]!, title: parts[2]! };
        });
    },
    downloadVideo: async (outputDir, videoId, useCookies = false) => {
      const url = `https://www.youtube.com/watch?v=${videoId}`;
      const cookieArgs = useCookies ? ["--cookies-from-browser", "chrome"] : [];
      const overwriteArgs = force ? [] : ["--no-overwrites"];
      await $`yt-dlp ${cookieArgs} ${overwriteArgs} -x --audio-format mp3 --audio-quality 0 --embed-thumbnail --embed-chapters --write-info-json --write-thumbnail --convert-thumbnails jpg --output ${`${outputDir}/audio.%(ext)s`} ${url}`.quiet();
    },
    downloadChannelArtwork: async (outputDir, channelUrl) => {
      await $`yt-dlp --write-thumbnail --skip-download --playlist-items 0 --convert-thumbnails jpg -o ${`${outputDir}/channel_avatar`} ${channelUrl}`.quiet();
    },
  };
}
