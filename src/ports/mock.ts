import { type Mock, spyOn } from "bun:test";

import { jsonPath } from "@/typed-path";
import type { WhisperJson } from "@/types";

import { createMemoryFs } from "./memory-fs";
import { createStubPorts } from "./stub";
import type { FileSystem, Ports } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SpiedInterface<T> = { [K in keyof T]: T[K] & Mock<(...args: any[]) => any> };
export type SpiedPorts = { [K in keyof Ports]: SpiedInterface<Ports[K]> };

function spyAllMethods(ports: Ports): SpiedPorts {
  for (const portName of Object.keys(ports) as (keyof Ports)[]) {
    const port = ports[portName];
    for (const method of Object.keys(port)) {
      spyOn(port, method as never);
    }
  }
  return ports as unknown as SpiedPorts;
}

export function createMockPorts(
  fs: FileSystem = createMemoryFs(),
  overrides?: Partial<Ports>,
): Ports {
  const stub = createStubPorts();
  return {
    fs,
    ytdlp: {
      ...stub.ytdlp,
      downloadChannelArtwork: async (outputDir) => {
        await fs.writeText(`${outputDir}/channel_avatar.jpg`, "fake-avatar");
      },
      ...overrides?.ytdlp,
    },
    ffmpeg: {
      cropThumbnail: async (_input, output) => {
        await fs.writeText(output, "fake-cropped-thumb");
      },
      processChannelArtwork: async (_raw, output) => {
        await fs.writeText(output, "fake-artwork");
      },
      embedChapters: async (_audio, _chapters, output) => {
        await fs.writeText(output, "fake-embedded-audio");
      },
      ...overrides?.ffmpeg,
    },
    whisper: {
      transcribe: async (_audioPath, outputDir) => {
        const srt = `${outputDir}/audio.srt`;
        const json = `${outputDir}/audio.json`;
        await fs.writeText(srt, "1\n00:00:00,000 --> 00:00:05,000\nMock transcript\n");
        await fs.writeText(
          json,
          JSON.stringify({
            transcription: [
              {
                timestamps: { from: "00:00:00,000", to: "00:00:05,000" },
                offsets: { from: 0, to: 5000 },
                text: " Mock transcript segment one.",
              },
              {
                timestamps: { from: "00:00:05,000", to: "00:00:10,000" },
                offsets: { from: 5000, to: 10000 },
                text: " Mock transcript segment two.",
              },
            ],
          }),
        );
        return { srt, json: jsonPath<WhisperJson>(json) };
      },
      ...overrides?.whisper,
    },
    claude: {
      call: async () => "Mock summary of the episode content.",
      ...overrides?.claude,
    },
    storage: {
      ...stub.storage,
      ...overrides?.storage,
    },
  };
}

export function createSpyPorts(fs: FileSystem, overrides?: Partial<Ports>): SpiedPorts {
  return spyAllMethods(createMockPorts(fs, overrides));
}
