import { $ } from "bun";

import type { YouTubeDownloader } from "./types";

const PRINT_FMT = "%(id)s|%(upload_date)s|%(title)s";

export function createRealYtdlp(opts?: { force?: boolean; cookies?: boolean }): YouTubeDownloader {
  const baseArgs: string[] = [
    ...(opts?.cookies ? ["--cookies-from-browser", "chrome"] : []),
    ...(opts?.force ? ["--force-overwrites"] : []),
  ];
  const ytdlp = (args: string[]) => $`yt-dlp ${[...baseArgs, ...args]}`.quiet();

  return {
    fetchVideoList: async (channelUrl) => {
      const output = await ytdlp(["--flat-playlist", "--print", PRINT_FMT, channelUrl]).text();
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
    downloadVideo: async (outputDir, videoId) => {
      const url = `https://www.youtube.com/watch?v=${videoId}`;
      const result = await ytdlp([
        "-x",
        "--audio-format",
        "mp3",
        "--audio-quality",
        "0",
        "--embed-thumbnail",
        "--embed-chapters",
        "--write-info-json",
        "--write-thumbnail",
        "--convert-thumbnails",
        "jpg",
        "--output",
        `${outputDir}/audio.%(ext)s`,
        url,
      ]).nothrow();
      if (result.exitCode !== 0) {
        const stderr = result.stderr.toString().trim();
        throw new Error(stderr || `yt-dlp exited with code ${result.exitCode}`);
      }
    },
    downloadChannelArtwork: async (outputDir, channelUrl) => {
      await ytdlp([
        "--write-thumbnail",
        "--skip-download",
        "--playlist-items",
        "0",
        "--convert-thumbnails",
        "jpg",
        "-o",
        `${outputDir}/channel_avatar`,
        channelUrl,
      ]);
    },
  };
}
