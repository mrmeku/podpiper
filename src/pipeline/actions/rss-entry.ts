import type { JsonPath } from "@/typed-path";
import { jsonPath, readJson } from "@/typed-path";
import type { Chapter, ChaptersResult, Episode, UploadEntry, YtDlpInfo } from "@/types";
import type { NodeRef, NodeRefOf } from "@podpiper/dagraph";
import type { chapters } from "./chapters";
import { NodeKind, defineActionWithPorts } from "./define-action";
import type { download } from "./download";
import type { embedChapters } from "./embed-chapters";
import type { thumbnail } from "./thumbnail";
import type { transcribe } from "./transcribe";

export interface RssEntryParams {
  kind: typeof NodeKind.RssEntry;
  videoId: string;
  deps: {
    download: NodeRefOf<download>;
    transcribe?: NodeRefOf<transcribe>;
    thumbnail: NodeRefOf<thumbnail>;
    chapters: NodeRefOf<chapters>;
    embedChapters?: NodeRefOf<embedChapters>;
    summary?: NodeRef<string>;
  };
}

function toObjectKey(videoId: string, key: string) {
  return `${videoId}/${key}`;
}

const YT_URL_RE = /https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/g;

export function extractYouTubeIds(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(YT_URL_RE), (m) => m[1]!))];
}

export function buildEpisode(
  videoId: string,
  info: YtDlpInfo,
  chaptersResult: ChaptersResult,
  summaryText: string | undefined,
  audioFileSize: number | undefined,
  srtExists: boolean,
  resolvedLinks: Record<string, string> = {},
): Episode {
  const objectKey = (key: string) => toObjectKey(videoId, key);
  return {
    id: videoId,
    title: info.title,
    description: info.description ?? "",
    uploadDate: info.upload_date,
    duration: info.duration,
    filename: objectKey("audio.mp3"),
    fileSize: audioFileSize,
    resolvedLinks,
    summary: summaryText ?? null,
    thumbnail: objectKey("thumbnail.jpg"),
    chapters: chaptersResult.chapters,
    chaptersGenerated: chaptersResult.generated,
    transcript: srtExists ? objectKey("transcript.srt") : null,
  };
}

export async function buildUploadManifest(
  episode: Episode,
  paths: { audio: string; thumbnail: string; srt: string },
  srtExists: boolean,
  chapters: Chapter[],
  outputDir: string,
  writeText: (path: string, content: string) => Promise<void>,
): Promise<UploadEntry[]> {
  const uploads: UploadEntry[] = [
    { localPath: paths.audio, key: episode.filename },
    { localPath: paths.thumbnail, key: episode.thumbnail },
  ];
  if (srtExists) {
    uploads.push({ localPath: paths.srt, key: episode.transcript! });
  }
  if (chapters.length > 0) {
    const chaptersJson = JSON.stringify({ version: "1.2.0", chapters }, null, 2);
    const chaptersPath = `${outputDir}/chapters-upload.json`;
    await writeText(chaptersPath, chaptersJson);
    uploads.push({ localPath: chaptersPath, key: toObjectKey(episode.id, "chapters.json") });
  }
  return uploads;
}

export const rssEntry = defineActionWithPorts<RssEntryParams, {
  episode: JsonPath<Episode>;
  uploads: JsonPath<UploadEntry[]>;
}>({
  config: "rss-v5",
  action:
    ({ fs, ytdlp }) =>
    async (params, inputs, outputDir) => {
      const { videoId } = params;
      const info = await readJson(fs, inputs.download.info);
      const chaptersRaw = await readJson(fs, inputs.chapters);
      const chaptersResult: ChaptersResult = Array.isArray(chaptersRaw)
        ? { chapters: chaptersRaw, generated: false }
        : chaptersRaw;
      const summaryText = inputs.summary ? await fs.readText(inputs.summary) : undefined;
      const srtExists = inputs.transcribe ? await fs.exists(inputs.transcribe.srt) : false;
      const audioPath = inputs.embedChapters ?? inputs.download.audio;
      const audioFileSize = (await fs.stat(audioPath))?.size;
      const ytIds = extractYouTubeIds(info.description ?? "");
      const resolvedLinks = ytIds.length > 0 ? await ytdlp.fetchVideoTitles(ytIds) : {};

      const episode = buildEpisode(videoId, info, chaptersResult, summaryText, audioFileSize, srtExists, resolvedLinks);
      const uploads = await buildUploadManifest(
        episode,
        { audio: audioPath, thumbnail: inputs.thumbnail, srt: inputs.transcribe?.srt ?? "" },
        srtExists,
        chaptersResult.chapters,
        outputDir,
        fs.writeText,
      );

      const episodePath = `${outputDir}/episode.json`;
      const uploadsPath = `${outputDir}/uploads.json`;
      await fs.writeText(episodePath, JSON.stringify(episode));
      await fs.writeText(uploadsPath, JSON.stringify(uploads));
      return { episode: jsonPath<Episode>(episodePath), uploads: jsonPath<UploadEntry[]>(uploadsPath) };
    },
});
export type rssEntry = typeof rssEntry;
