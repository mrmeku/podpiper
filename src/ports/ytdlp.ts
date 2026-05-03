import { $ } from "bun";

import { exec } from "@/ports/exec";
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

export function createRealYtdlp(opts?: { force?: boolean; cookies?: string }): YouTubeDownloader {
  const baseArgs: string[] = [
    "--impersonate", "chrome",
    "--extractor-args", "youtube:player_client=web",
    "--sleep-requests", "1",
    "--throttled-rate", "100K",
    "--retry-sleep", "http:exp=1:30",
    ...(opts?.cookies ? ["--cookies", opts.cookies] : []),
    ...(opts?.force ? ["--force-overwrites"] : []),
  ];
  const ytdlpArgs = (args: string[]) => ["yt-dlp", ...baseArgs, ...args];

  return {
    fetchVideoList: async (config) => {
      const playlistItems = config.playlistOffset
        ? ["--playlist-items", `1:${config.playlistOffset}`]
        : [];
      const args = ["--flat-playlist", ...playlistItems, "--print", PRINT_FMT, config.channelUrl];
      const output = await exec(ytdlpArgs(args));
      const videos = parseVideoList(output);
      if (config.startDate) {
        return videos.filter((v) => v.uploadDate >= config.startDate!);
      }
      return videos;
    },
    fetchVideoTitles: async (videoIds) => {
      if (videoIds.length === 0) return {};
      const urls = videoIds.map((id) => `https://www.youtube.com/watch?v=${id}`);
      const result = await $`${ytdlpArgs(["--print", "%(id)s|%(title)s", ...urls])}`
        .quiet()
        .nothrow();
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
        "--sleep-interval",
        "3",
        "--max-sleep-interval",
        "8",
        "--downloader-args",
        "ffmpeg_i:-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5",
        "--output",
        `${outputDir}/audio.%(ext)s`,
        url,
      ];
      const result = await $`${ytdlpArgs(dlArgs)}`.quiet().nothrow();
      if (result.exitCode !== 0) {
        const stderr = result.stderr.toString().trim();
        if (!opts?.cookies && stderr.includes("Sign in to confirm your age")) {
          throw new Error("Age-restricted video requires cookies. Re-run with --cookies <path>.");
        }
        throw new Error(stderr || `yt-dlp exited with code ${result.exitCode}`);
      }
    },
    downloadChannelArtwork: async (outputDir, channelUrl) => {
      await exec(
        ytdlpArgs([
          "--write-thumbnail",
          "--skip-download",
          "--playlist-items",
          "0",
          "--convert-thumbnails",
          "jpg",
          "-o",
          `${outputDir}/channel_avatar`,
          channelUrl,
        ]),
      );
    },
  };
}
