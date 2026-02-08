import type { NodeRef } from "@/dag/types";
import { toVideoDir } from "@/paths";
import type { TranscribeResult } from "@/ports/types";
import type { Chapter, Episode, HasUploads, UploadEntry, VideoInfo, YtDlpInfo } from "@/types";

import { defineAction } from "../define-action";
import type { DownloadResult } from "./download";
import { NodeKind } from "./node-kind";

export interface EpisodeOutput extends HasUploads {
  episode: Episode;
}

export interface RssEntryParams {
  kind: typeof NodeKind.RssEntry;
  video: VideoInfo;
  outputDir: string;
  deps: {
    download: NodeRef<DownloadResult>;
    transcribe: NodeRef<TranscribeResult>;
    thumbnail: NodeRef<string>;
    chapters: NodeRef<Chapter[]>;
    summary?: NodeRef<string>;
  };
}

function toR2Key(video: VideoInfo, key: string) {
  return `${video.id}/${key}`;
}

export const rssEntry = defineAction<RssEntryParams, EpisodeOutput>({
  name: (p) => `rss_entry:${p.video.id}`,
  config: "rss-v2",
  action: (ports) => async (params, inputs) => {
    const description =
      inputs.summary ??
      (await ports.fs.readJson<YtDlpInfo>(inputs.download.info)).description ??
      "";
    const stat = await ports.fs.stat(inputs.download.audio);
    const info = await ports.fs.readJson<YtDlpInfo>(inputs.download.info);
    const srtExists = await ports.fs.exists(inputs.transcribe.srt);
    const episode: Episode = {
      id: params.video.id,
      title: info.title,
      description,
      uploadDate: info.upload_date,
      duration: info.duration ?? 0,
      filename: toR2Key(params.video, "audio.mp3"),
      fileSize: stat?.size ?? 0,
      thumbnail: toR2Key(params.video, "thumbnail.jpg"),
      chapters: inputs.chapters,
      transcript: srtExists ? toR2Key(params.video, "transcript.srt") : null,
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
      const chaptersPath = `${toVideoDir(params.outputDir, params.video.id)}/chapters.json`;
      await ports.fs.writeText(chaptersPath, chaptersJson);
      uploads.push({ localPath: chaptersPath, r2Key: toR2Key(params.video, "chapters.json") });
    }
    return { episode, uploads };
  },
});
