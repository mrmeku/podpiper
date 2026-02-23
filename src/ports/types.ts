import type { JsonPath } from "@/typed-path";
import type { VideoInfo, WhisperJson } from "@/types";

export interface FileSystem {
  exists: (path: string) => Promise<boolean>;
  readText: (path: string) => Promise<string>;
  readJson: <T = unknown>(path: string) => Promise<T>;
  readBinary: (path: string) => Promise<Uint8Array>;
  writeText: (path: string, content: string) => Promise<void>;
  stat: (path: string) => Promise<{ size: number } | null>;
  readdir: (path: string) => Promise<{ name: string; isDirectory(): boolean }[]>;
  hashFile: (path: string) => Promise<string>;
  ensureDir: (path: string) => Promise<void>;
}

export interface YouTubeDownloader {
  fetchVideoList: (channelUrl: string) => Promise<VideoInfo[]>;
  downloadVideo: (outputDir: string, videoId: string) => Promise<void>;
  downloadChannelArtwork: (outputDir: string, channelUrl: string) => Promise<void>;
}

export interface MediaProcessor {
  cropThumbnail: (input: string, output: string) => Promise<void>;
  processChannelArtwork: (rawPath: string, outputPath: string) => Promise<void>;
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
    filePath: string,
    key: string,
    bucket: string,
    cacheControl?: string,
  ) => Promise<void>;
  getFile: (bucket: string, key: string) => Promise<Uint8Array | null>;
  listFiles: (bucket: string) => Promise<Set<string>>;
}

export interface Ports {
  fs: FileSystem;
  ytdlp: YouTubeDownloader;
  ffmpeg: MediaProcessor;
  whisper: Transcriber;
  claude: Llm;
  storage: ObjectStore;
}
