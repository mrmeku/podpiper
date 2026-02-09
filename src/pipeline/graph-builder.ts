import type { Graph } from "@/dag/graph";
import type { NodeRef } from "@/dag/types";
import type { Ports } from "@/ports/types";
import type { Config, HasUploads, VideoInfo } from "@/types";

import { artwork, channelAvatar } from "./actions/artwork";
import { chapters } from "./actions/chapters";
import { NodeKind } from "./actions/define-action";
import { download } from "./actions/download";
import type { EpisodeOutput, RssEntryParams } from "./actions/rss-entry";
import { rssEntry } from "./actions/rss-entry";
import { summary } from "./actions/summary";
import { thumbnail } from "./actions/thumbnail";
import { transcribe } from "./actions/transcribe";

function addVideoSubgraph(
  graph: Graph,
  video: VideoInfo,
  ports: Ports,
  config: Config,
): NodeRef<EpisodeOutput> {
  const dl = download.addNode(graph, ports, {
    kind: NodeKind.Download,
    videoId: video.id,
    outputDir: config.outputDir,
  });
  const tr = transcribe.addNode(graph, ports, {
    kind: NodeKind.Transcribe,
    videoId: video.id,
    outputDir: config.outputDir,
    deps: { download: dl },
  });
  const th = thumbnail.addNode(graph, ports, {
    kind: NodeKind.Thumbnail,
    videoId: video.id,
    outputDir: config.outputDir,
    deps: { download: dl },
  });
  const ch = chapters.addNode(graph, ports, {
    kind: NodeKind.Chapters,
    videoId: video.id,
    chapterPrompt: config.chapterPrompt,
    deps: { download: dl, transcribe: tr },
  });
  const deps: RssEntryParams["deps"] = {
    download: dl,
    transcribe: tr,
    thumbnail: th,
    chapters: ch,
  };
  if (config.summaryPrompt) {
    deps.summary = summary.addNode(graph, ports, {
      kind: NodeKind.Summary,
      videoId: video.id,
      summaryPrompt: config.summaryPrompt,
      deps: { download: dl, transcribe: tr },
    });
  }
  return rssEntry.addNode(graph, ports, {
    kind: NodeKind.RssEntry,
    videoId: video.id,
    outputDir: config.outputDir,
    deps,
  });
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
  const avatarDir = `${config.outputDir}/artwork`;
  const artworkPath = `${config.outputDir}/artwork.jpg`;
  const avatarRef = channelAvatar.addNode(graph, ports, {
    kind: NodeKind.ChannelAvatar,
    channelUrl: config.channelUrl,
    avatarDir,
  });
  const artworkRef = artwork.addNode(graph, ports, {
    kind: NodeKind.Artwork,
    artworkPath,
    deps: { channel_avatar: avatarRef },
  });
  return {
    publishRefs: [...entryRefs, artworkRef],
    entryRefs,
  };
}
