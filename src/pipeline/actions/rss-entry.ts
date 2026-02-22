import type { TranscribeResult } from "@/ports/types";
import type { JsonPath } from "@/typed-path";
import { jsonPath, readJson } from "@/typed-path";
import type { Chapter, Episode, UploadEntry } from "@/types";
import type { NodeRef } from "@podpiper/dag/types";
import { NodeKind, defineActionWithPorts, toVideoActionName, toVideoDir } from "./define-action";
import type { DownloadResult } from "./download";

export type RssEntryResult = {
  episode: JsonPath<Episode>;
  uploads: JsonPath<UploadEntry[]>;
};

export interface RssEntryParams {
  kind: typeof NodeKind.RssEntry;
  videoId: string;
  outputDir: string;
  deps: {
    download: NodeRef<DownloadResult>;
    transcribe: NodeRef<TranscribeResult>;
    thumbnail: NodeRef<string>;
    chapters: NodeRef<JsonPath<Chapter[]>>;
    summary?: NodeRef<string>;
  };
}

function toR2Key(videoId: string, key: string) {
  return `${videoId}/${key}`;
}

export function toEpisodeFile(outputDir: string, videoId: string): string {
  return `${toVideoDir(outputDir, videoId)}/episode.json`;
}

export function toUploadsFile(outputDir: string, videoId: string): string {
  return `${toVideoDir(outputDir, videoId)}/uploads.json`;
}

export const rssEntry = defineActionWithPorts<RssEntryParams, RssEntryResult>({
  name: toVideoActionName,
  config: "rss-v4",
  action:
    ({ fs }) =>
    async (params, inputs) => {
      const { videoId, outputDir } = params;
      const dir = toVideoDir(outputDir, videoId);
      const r2 = (key: string) => toR2Key(videoId, key);

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
        filename: r2("audio.mp3"),
        fileSize: (await fs.stat(inputs.download.audio))?.size,
        thumbnail: r2("thumbnail.jpg"),
        chapters,
        transcript: srtExists ? r2("transcript.srt") : null,
      };

      // Build upload manifest
      const uploads: UploadEntry[] = [
        { localPath: inputs.download.audio, r2Key: episode.filename },
        { localPath: inputs.thumbnail, r2Key: episode.thumbnail! },
      ];
      if (srtExists) {
        uploads.push({ localPath: inputs.transcribe.srt, r2Key: episode.transcript! });
      }
      if (chapters.length > 0) {
        const chaptersJson = JSON.stringify({ version: "1.2.0", chapters }, null, 2);
        const chaptersPath = `${dir}/chapters-upload.json`;
        await fs.writeText(chaptersPath, chaptersJson);
        uploads.push({ localPath: chaptersPath, r2Key: r2("chapters.json") });
      }

      const episodePath = `${dir}/episode.json`;
      const uploadsPath = `${dir}/uploads.json`;
      await fs.writeText(episodePath, JSON.stringify(episode));
      await fs.writeText(uploadsPath, JSON.stringify(uploads));
      return { episode: jsonPath<Episode>(episodePath), uploads: jsonPath<UploadEntry[]>(uploadsPath) };
    },
});
