import { $ } from "bun";

import type { MediaProcessor } from "./types";

export function createRealFfmpeg(): MediaProcessor {
  return {
    cropThumbnail: async (input, output) => {
      await $`ffmpeg -y -i ${input} -vf ${"pad=iw:iw:0:(oh-ih)/2:black,scale=1400:1400:flags=lanczos"} -q:v 2 ${output}`.quiet();
    },
    processChannelArtwork: async (rawPath, outputPath) => {
      await $`ffmpeg -y -i ${rawPath} -vf ${"scale=1400:1400:flags=lanczos"} -q:v 2 ${outputPath}`.quiet();
    },
  };
}
