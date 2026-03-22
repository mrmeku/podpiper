import { $ } from "bun";

import type { VideoInfo } from "@/types";
import type { YouTubeDownloader } from "./types";

const PRINT_FMT = "%(id)s|%(upload_date)s|%(title)s";

export function parseVideoList(output: string): VideoInfo[] {
  return output
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const parts = line.split("|");
      if (parts.length < 3) throw new Error(`Malformed yt-dlp output: ${line}`);
      return { id: parts[0]!, uploadDate: parts[1]!, title: parts.slice(2).join("|") };
    });
}

export function createRealYtdlp(opts?: { force?: boolean; cookies?: boolean }): YouTubeDownloader {
  const baseArgs: string[] = [
    ...(opts?.cookies ? ["--cookies-from-browser", "chrome"] : []),
    ...(opts?.force ? ["--force-overwrites"] : []),
  ];
  const ytdlp = (args: string[]) => $`yt-dlp ${[...baseArgs, ...args]}`.quiet();

  return {
    fetchVideoList: async (config) => {
      const playlistItems = config.playlistOffset
        ? ["--playlist-items", `1:${config.playlistOffset}`]
        : [];
      const args = ["--flat-playlist", ...playlistItems, "--print", PRINT_FMT, config.channelUrl];
      const output = await ytdlp(args).text();
      return parseVideoList(output);
    },
    fetchVideoTitles: async (videoIds) => {
      if (videoIds.length === 0) return {};
      const urls = videoIds.map((id) => `https://www.youtube.com/watch?v=${id}`);
      const result = await ytdlp(["--print", "%(id)s|%(title)s", ...urls]).nothrow();
      if (result.exitCode !== 0) return {};
      const titles: Record<string, string> = {};
      for (const line of result.stdout.toString().trim().split("\n")) {
        const sep = line.indexOf("|");
        if (sep > 0) titles[line.slice(0, sep)] = line.slice(sep + 1);
      }
      return titles;
    },
    downloadAudio: async (outputDir, videoId) => {
      const url = `https://www.youtube.com/watch?v=${videoId}`;
      const dlArgs = [
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
      ];
      const result = await ytdlp(dlArgs).nothrow();
      if (result.exitCode !== 0) {
        const stderr = result.stderr.toString().trim();
        if (!opts?.cookies && stderr.includes("Sign in to confirm your age")) {
          const retry = await $`yt-dlp --cookies-from-browser chrome ${[...baseArgs, ...dlArgs]}`
            .quiet()
            .nothrow();
          if (retry.exitCode !== 0) {
            const retryStderr = retry.stderr.toString().trim();
            throw new Error(retryStderr || `yt-dlp exited with code ${retry.exitCode}`);
          }
          return;
        }
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
