import type { Graph } from "@/dag/graph";
import { jsonRef } from "@/dag/types";
import type { NodeRef } from "@/dag/types";
import { toVideoDir } from "@/paths";
import type { FileSystem, TranscribeResult } from "@/ports/types";
import type {
  Chapter,
  Episode,
  HasUploads,
  UploadEntry,
  VideoInfo,
  YtDlpInfo,
} from "@/types";

import type { DownloadResult } from "./download";

export interface EpisodeOutput extends HasUploads {
  episode: Episode;
}

interface RssEntryDeps {
  download: NodeRef<DownloadResult>;
  transcribe: NodeRef<TranscribeResult>;
  thumbnail: NodeRef<string>;
  chapters: NodeRef<Chapter[]>;
  summary?: NodeRef<string>;
}

function toR2Key(video: VideoInfo, key: string) {
  return `${video.id}/${key}`;
}

export function addRssEntryNode(
  graph: Graph,
  video: VideoInfo,
  deps: RssEntryDeps,
  fs: FileSystem,
  outputDir: string,
): NodeRef<EpisodeOutput> {
  const name = `rss_entry:${video.id}`;
  const depNames = [
    deps.download.name,
    deps.transcribe.name,
    deps.thumbnail.name,
    deps.chapters.name,
  ];
  if (deps.summary) depNames.push(deps.summary.name);
  graph.add({
    name,
    deps: depNames,
    config: "rss-v2",
    action: async (inputs) => {
      const dl = deps.download.parse(inputs[deps.download.name]!);
      const tr = deps.transcribe.parse(inputs[deps.transcribe.name]!);
      const thumbPath = deps.thumbnail.parse(inputs[deps.thumbnail.name]!);
      const chapters = deps.chapters.parse(inputs[deps.chapters.name]!);
      const description = deps.summary
        ? deps.summary.parse(inputs[deps.summary.name]!)
        : ((await fs.readJson<YtDlpInfo>(dl.info)).description ?? "");
      const stat = await fs.stat(dl.audio);
      const info = await fs.readJson<YtDlpInfo>(dl.info);
      const srtExists = await fs.exists(tr.srt);
      const episode: Episode = {
        id: video.id,
        title: info.title,
        description,
        uploadDate: info.upload_date,
        duration: info.duration ?? 0,
        filename: toR2Key(video, "audio.mp3"),
        fileSize: stat?.size ?? 0,
        thumbnail: toR2Key(video, "thumbnail.jpg"),
        chapters,
        transcript: srtExists ? toR2Key(video, "transcript.srt") : null,
      };
      const uploads: UploadEntry[] = [
        {
          localPath: dl.audio,
          r2Key: episode.filename,
          cacheControl: "max-age=31536000",
        },
        {
          localPath: thumbPath,
          r2Key: episode.thumbnail!,
          cacheControl: "max-age=31536000",
        },
      ];
      if (episode.transcript) {
        uploads.push({
          localPath: tr.srt,
          r2Key: episode.transcript,
          cacheControl: "max-age=31536000",
        });
      }
      if (chapters.length > 0) {
        const chaptersJson = JSON.stringify(
          { version: "1.2.0", chapters },
          null,
          2,
        );
        const chaptersPath = `${toVideoDir(outputDir, video.id)}/chapters.json`;
        await fs.writeText(chaptersPath, chaptersJson);
        uploads.push({
          localPath: chaptersPath,
          r2Key: toR2Key(video, "chapters.json"),
          cacheControl: "max-age=31536000",
        });
      }
      return JSON.stringify({ episode, uploads } satisfies EpisodeOutput);
    },
  });
  return jsonRef<EpisodeOutput>(name);
}
