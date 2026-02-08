import type { Graph } from "@/dag/graph";
import { addNode } from "@/dag/graph";
import { jsonRef } from "@/dag/types";
import type { ActionFunc, NodeRef } from "@/dag/types";
import { toVideoDir } from "@/paths";
import type { FileSystem, TranscribeResult } from "@/ports/types";
import type { Chapter, Episode, HasUploads, UploadEntry, VideoInfo, YtDlpInfo } from "@/types";

import type { DownloadResult } from "./download";
import { NodeKind } from "./node-kind";

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

export interface RssEntryParams {
  kind: typeof NodeKind.RssEntry;
  video: VideoInfo;
  outputDir: string;
  deps: { download: string; transcribe: string; thumbnail: string; chapters: string; summary?: string };
}

function toR2Key(video: VideoInfo, key: string) {
  return `${video.id}/${key}`;
}

export function rssEntryAction(fs: FileSystem): ActionFunc<RssEntryParams> {
  return async (params, inputs) => {
    const dl: DownloadResult = JSON.parse(inputs.download);
    const tr: TranscribeResult = JSON.parse(inputs.transcribe);
    const thumbPath = inputs.thumbnail;
    const chapters: Chapter[] = JSON.parse(inputs.chapters);
    const description = inputs.summary
      ? inputs.summary
      : ((await fs.readJson<YtDlpInfo>(dl.info)).description ?? "");
    const stat = await fs.stat(dl.audio);
    const info = await fs.readJson<YtDlpInfo>(dl.info);
    const srtExists = await fs.exists(tr.srt);
    const episode: Episode = {
      id: params.video.id,
      title: info.title,
      description,
      uploadDate: info.upload_date,
      duration: info.duration ?? 0,
      filename: toR2Key(params.video, "audio.mp3"),
      fileSize: stat?.size ?? 0,
      thumbnail: toR2Key(params.video, "thumbnail.jpg"),
      chapters,
      transcript: srtExists ? toR2Key(params.video, "transcript.srt") : null,
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
      const chaptersJson = JSON.stringify({ version: "1.2.0", chapters }, null, 2);
      const chaptersPath = `${toVideoDir(params.outputDir, params.video.id)}/chapters.json`;
      await fs.writeText(chaptersPath, chaptersJson);
      uploads.push({
        localPath: chaptersPath,
        r2Key: toR2Key(params.video, "chapters.json"),
        cacheControl: "max-age=31536000",
      });
    }
    return JSON.stringify({ episode, uploads } satisfies EpisodeOutput);
  };
}

export function addRssEntryNode(
  graph: Graph,
  video: VideoInfo,
  deps: RssEntryDeps,
  fs: FileSystem,
  outputDir: string,
): NodeRef<EpisodeOutput> {
  const name = `rss_entry:${video.id}`;
  addNode(graph, name, "rss-v2", {
    kind: NodeKind.RssEntry, video, outputDir,
    deps: {
      download: deps.download.name,
      transcribe: deps.transcribe.name,
      thumbnail: deps.thumbnail.name,
      chapters: deps.chapters.name,
      ...(deps.summary ? { summary: deps.summary.name } : {}),
    },
  } satisfies RssEntryParams, rssEntryAction(fs));
  return jsonRef<EpisodeOutput>(name);
}
