import type { Graph } from "@/dag/graph";
import type { NodeRef } from "@/dag/types";
import type { Ports } from "@/ports/types";
import type { Config, HasUploads, VideoInfo } from "@/types";

import { addArtworkNodes } from "./actions/artwork";
import { addChaptersNode } from "./actions/chapters";
import { addDownloadNode } from "./actions/download";
import type { EpisodeOutput } from "./actions/rss-entry";
import { addRssEntryNode } from "./actions/rss-entry";
import { addSummaryNode } from "./actions/summary";
import { addThumbnailNode } from "./actions/thumbnail";
import { addTranscribeNode } from "./actions/transcribe";

function addVideoSubgraph(
  graph: Graph,
  video: VideoInfo,
  ports: Ports,
  config: Config,
): NodeRef<EpisodeOutput> {
  const download = addDownloadNode(graph, video.id, ports.ytdlp, config.outputDir);
  const transcribe = addTranscribeNode(graph, video.id, download, ports.whisper, config.outputDir);
  const thumbnail = addThumbnailNode(graph, video.id, download, ports.ffmpeg, config.outputDir);
  const chapters = addChaptersNode(
    graph,
    video.id,
    download,
    transcribe,
    ports.fs,
    ports.claude,
    config.chapterPrompt,
  );
  const baseDeps = { download, transcribe, thumbnail, chapters };
  if (config.summaryPrompt) {
    const summary = addSummaryNode(
      graph,
      video.id,
      download,
      transcribe,
      ports.fs,
      ports.claude,
      config.summaryPrompt,
    );
    return addRssEntryNode(graph, video, { ...baseDeps, summary }, ports.fs, config.outputDir);
  }
  return addRssEntryNode(graph, video, baseDeps, ports.fs, config.outputDir);
}

export interface PipelineRefs {
  publishRefs: NodeRef<HasUploads>[];
  entryRefs: NodeRef<EpisodeOutput>[];
}

export function buildPipelineGraph(
  graph: Graph,
  videos: VideoInfo[],
  ports: Ports,
  config: Config,
): PipelineRefs {
  const entryRefs = videos.map((video) => addVideoSubgraph(graph, video, ports, config));
  const artworkRef = addArtworkNodes(
    graph,
    config.channelUrl,
    ports.ytdlp,
    ports.ffmpeg,
    config.outputDir,
  );
  return {
    publishRefs: [...entryRefs, artworkRef],
    entryRefs,
  };
}
