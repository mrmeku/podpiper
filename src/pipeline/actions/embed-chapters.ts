import { readJson } from "@/typed-path";
import type { NodeRefOf } from "@podpiper/dagraph";
import type { chapters } from "./chapters";
import { NodeKind, defineActionWithPorts } from "./define-action";
import type { download } from "./download";

export interface EmbedChaptersParams {
  kind: typeof NodeKind.EmbedChapters;
  videoId: string;
  deps: {
    download: NodeRefOf<download>;
    chapters: NodeRefOf<chapters>;
  };
}

export const embedChapters = defineActionWithPorts<EmbedChaptersParams, string>({
  config: "id3-chap-v1",
  action: (ports) => async (_params, inputs, outputDir) => {
    const { chapters } = await readJson(ports.fs, inputs.chapters);
    const outputPath = `${outputDir}/audio.mp3`;
    await ports.ffmpeg.embedChapters(inputs.download.audio, chapters, outputPath);
    return outputPath;
  },
});
export type embedChapters = typeof embedChapters;
