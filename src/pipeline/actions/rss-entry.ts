import type { JsonPath } from "@/typed-path";
import { jsonPath, readJson } from "@/typed-path";
import type { Episode, UploadEntry } from "@/types";
import type { NodeRef, NodeRefOf } from "@podpiper/dagraph";
import type { chapters } from "./chapters";
import { NodeKind, defineActionWithPorts, toVideoActionName } from "./define-action";
import type { download } from "./download";
import type { transcribe } from "./transcribe";

export interface RssEntryParams {
  kind: typeof NodeKind.RssEntry;
  videoId: string;
  deps: {
    download: NodeRefOf<download>;
    transcribe: NodeRefOf<transcribe>;
    thumbnail: NodeRef<string>;
    chapters: NodeRefOf<chapters>;
    embedChapters?: NodeRef<string>;
    summary?: NodeRef<string>;
  };
}

function toObjectKey(videoId: string, key: string) {
  return `${videoId}/${key}`;
}

export const rssEntry = defineActionWithPorts<RssEntryParams, {
  episode: JsonPath<Episode>;
  uploads: JsonPath<UploadEntry[]>;
}>({
  name: toVideoActionName,
  config: "rss-v4",
  action:
    ({ fs }) =>
    async (params, inputs, outputDir) => {
      const { videoId } = params;
      const objectKey = (key: string) => toObjectKey(videoId, key);

      const info = await readJson(fs, inputs.download.info);
      const chapters = await readJson(fs, inputs.chapters);
      const summaryText = inputs.summary ? await fs.readText(inputs.summary) : undefined;

      const description = [info.description, summaryText]
        .filter(Boolean)
        .join("\n\n— Generated Summary —\n\n");

      const srtExists = await fs.exists(inputs.transcribe.srt);

      const episode: Episode = {
        id: videoId,
        title: info.title,
        description,
        uploadDate: info.upload_date,
        duration: info.duration,
        filename: objectKey("audio.mp3"),
        fileSize: (await fs.stat(inputs.download.audio))?.size,
        thumbnail: objectKey("thumbnail.jpg"),
        chapters,
        transcript: srtExists ? objectKey("transcript.srt") : null,
      };

      const uploads: UploadEntry[] = [
        { localPath: inputs.download.audio, key: episode.filename },
        { localPath: inputs.thumbnail, key: episode.thumbnail! },
      ];
      if (srtExists) {
        uploads.push({ localPath: inputs.transcribe.srt, key: episode.transcript! });
      }
      if (chapters.length > 0) {
        const chaptersJson = JSON.stringify({ version: "1.2.0", chapters }, null, 2);
        const chaptersPath = `${outputDir}/chapters-upload.json`;
        await fs.writeText(chaptersPath, chaptersJson);
        uploads.push({ localPath: chaptersPath, key: objectKey("chapters.json") });
      }

      const episodePath = `${outputDir}/episode.json`;
      const uploadsPath = `${outputDir}/uploads.json`;
      await fs.writeText(episodePath, JSON.stringify(episode));
      await fs.writeText(uploadsPath, JSON.stringify(uploads));
      return { episode: jsonPath<Episode>(episodePath), uploads: jsonPath<UploadEntry[]>(uploadsPath) };
    },
});
export type rssEntry = typeof rssEntry;
