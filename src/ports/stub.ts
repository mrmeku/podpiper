import { jsonPath } from "@/typed-path";
import type { WhisperJson } from "@/types";

import type { Ports } from "./types";

const noop = async () => {};

export function createStubPorts(): Ports {
  return {
    fs: {
      exists: async () => false,
      readText: async () => "",
      readBinary: async () => new Uint8Array(),
      readJson: async () => ({}) as never,
      writeText: noop,
      stat: async () => null,
      hashFile: async () => "",
      ensureDir: noop,
    },
    ytdlp: {
      fetchVideoList: async () => [],
      fetchVideoTitles: async () => ({}),
      downloadVideo: noop,
      downloadChannelArtwork: noop,
    },
    ffmpeg: { cropThumbnail: noop, processChannelArtwork: noop, embedChapters: noop },
    whisper: { transcribe: async () => ({ srt: "", json: jsonPath<WhisperJson>("") }) },
    claude: { call: async () => "" },
    storage: {
      uploadFile: noop,
      getFile: async () => null,
      fileExists: async () => false,
    },
  };
}
