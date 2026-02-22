import { jsonPath } from "@/typed-path";
import type { WhisperJson } from "@/types";

import type { Ports } from "./types";

const noop = async () => {};

export function createStubPorts(): Ports {
  return {
    fs: {
      exists: async () => false,
      readText: async () => "",
      readJson: async () => ({}) as never,
      readBinary: async () => new Uint8Array(),
      writeText: noop,
      stat: async () => null,
      readdir: async () => [],
      hashFile: async () => "",
    },
    ytdlp: {
      fetchVideoList: async () => [],
      downloadVideo: noop,
      downloadChannelArtwork: noop,
    },
    ffmpeg: { cropThumbnail: noop, processChannelArtwork: noop },
    whisper: { transcribe: async () => ({ srt: "", json: jsonPath<WhisperJson>("") }) },
    claude: { call: async () => "" },
    storage: {
      uploadFile: noop,
      getFile: async () => null,
      listFiles: async () => new Set(),
    },
  };
}
