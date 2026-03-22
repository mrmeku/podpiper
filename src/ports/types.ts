import type { JsonPath } from "@/typed-path";
import type { Chapter, Config, VideoInfo, WhisperJson } from "@/types";

export interface FileSystem {
  exists: (path: string) => Promise<boolean>;
  readText: (path: string) => Promise<string>;
  readBinary: (path: string) => Promise<Uint8Array>;
  readJson: <T = unknown>(path: string) => Promise<T>;
  writeText: (path: string, content: string) => Promise<void>;
  writeBinary: (path: string, data: Uint8Array) => Promise<void>;
  stat: (path: string) => Promise<{ size: number } | null>;
  hashFile: (path: string) => Promise<string>;
  ensureDir: (path: string) => Promise<void>;
  readdir: (path: string) => Promise<string[]>;
}

export interface YouTubeDownloader {
  fetchVideoList: (config: Pick<Config, "channelUrl" | "playlistOffset">) => Promise<VideoInfo[]>;
  fetchVideoTitles: (videoIds: string[]) => Promise<Record<string, string>>;
  downloadAudio: (outputDir: string, videoId: string) => Promise<void>;
  downloadChannelArtwork: (outputDir: string, channelUrl: string) => Promise<void>;
}

export interface MediaProcessor {
  squareThumbnail: (input: string, output: string) => Promise<void>;
  processChannelArtwork: (rawPath: string, outputPath: string) => Promise<void>;
  embedChapters: (audioPath: string, chapters: Chapter[], outputPath: string) => Promise<void>;
}

export type TranscribeResult = {
  srt: string;
  json: JsonPath<WhisperJson>;
};

export interface Transcriber {
  transcribe: (audioPath: string, outputDir: string) => Promise<TranscribeResult>;
}

export interface Llm {
  call: (prompt: string) => Promise<string>;
}

export interface ObjectStore {
  uploadFile: (
    data: Uint8Array,
    key: string,
    bucket: string,
    cacheControl?: string,
  ) => Promise<void>;
  getFile: (bucket: string, key: string) => Promise<Uint8Array | null>;
  fileExists: (bucket: string, key: string) => Promise<boolean>;
}

export interface Clock {
  now: () => Date;
}

export interface Ports {
  fs: FileSystem;
  ytdlp: YouTubeDownloader;
  ffmpeg: MediaProcessor;
  whisper: Transcriber;
  claude: Llm;
  storage: ObjectStore;
  clock: Clock;
}
