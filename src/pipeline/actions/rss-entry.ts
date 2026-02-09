import type { NodeRef } from "@podpiper/dag/types";
import type { TranscribeResult } from "@/ports/types";
import type { Chapter, Episode, HasUploads, UploadEntry, YtDlpInfo } from "@/types";

import { NodeKind, defineActionWithPorts, toVideoActionName, toVideoDir } from "./define-action";
import type { DownloadResult } from "./download";

export interface EpisodeOutput extends HasUploads {
  episode: Episode;
}

export interface RssEntryParams {
  kind: typeof NodeKind.RssEntry;
  videoId: string;
  outputDir: string;
  deps: {
    download: NodeRef<DownloadResult>;
    transcribe: NodeRef<TranscribeResult>;
    thumbnail: NodeRef<string>;
    chapters: NodeRef<Chapter[]>;
    summary?: NodeRef<string>;
  };
}

function toR2Key(videoId: string, key: string) {
  return `${videoId}/${key}`;
}

export const rssEntry = defineActionWithPorts<RssEntryParams, EpisodeOutput>({
  name: toVideoActionName,
  config: "rss-v3",
  action: (ports) => async (params, inputs) => {
    const description = [
      (await ports.fs.readJson<YtDlpInfo>(inputs.download.info)).description,
      inputs.summary,
    ]
      .filter(Boolean)
      .join("\n\n— Generated Summary —\n\n");
    const stat = await ports.fs.stat(inputs.download.audio);
    const info = await ports.fs.readJson<YtDlpInfo>(inputs.download.info);
    const srtExists = await ports.fs.exists(inputs.transcribe.srt);
    const episode: Episode = {
      id: params.videoId,
      title: info.title,
      description,
      uploadDate: info.upload_date,
      duration: info.duration ?? 0,
      filename: toR2Key(params.videoId, "audio.mp3"),
      fileSize: stat?.size ?? 0,
      thumbnail: toR2Key(params.videoId, "thumbnail.jpg"),
      chapters: inputs.chapters,
      transcript: srtExists ? toR2Key(params.videoId, "transcript.srt") : null,
    };
    const uploads: UploadEntry[] = [
      { localPath: inputs.download.audio, r2Key: episode.filename },
      { localPath: inputs.thumbnail, r2Key: episode.thumbnail! },
    ];
    if (episode.transcript) {
      uploads.push({ localPath: inputs.transcribe.srt, r2Key: episode.transcript });
    }
    if (inputs.chapters.length > 0) {
      const chaptersJson = JSON.stringify({ version: "1.2.0", chapters: inputs.chapters }, null, 2);
      const chaptersPath = `${toVideoDir(params.outputDir, params.videoId)}/chapters.json`;
      await ports.fs.writeText(chaptersPath, chaptersJson);
      uploads.push({ localPath: chaptersPath, r2Key: toR2Key(params.videoId, "chapters.json") });
    }
    return { episode, uploads };
  },
});
