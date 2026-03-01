import type { Ports } from "@/ports/types";
import type { Config, VideoInfo } from "@/types";
import { Graph, type KindEdge, type NodeRefOf, type ScopeOpts } from "@podpiper/dagraph";

import { artwork, channelAvatar } from "./actions/artwork";
import { chapters } from "./actions/chapters";
import { NodeKind } from "./actions/define-action";
import { download } from "./actions/download";
import { embedChapters } from "./actions/embed-chapters";
import type { RssEntryParams } from "./actions/rss-entry";
import { rssEntry } from "./actions/rss-entry";
import { summary } from "./actions/summary";
import { thumbnail } from "./actions/thumbnail";
import { transcribe } from "./actions/transcribe";

export function buildVideoGraph(video: VideoInfo, ports: Ports, config: Config): Graph {
  const graph = new Graph();
  addVideoSubgraph(graph, video, ports, config);
  return graph;
}

function addVideoSubgraph(
  graph: Graph,
  video: VideoInfo,
  ports: Ports,
  config: Config,
  scopeOpts?: ScopeOpts,
): NodeRefOf<rssEntry> {
  const scope = graph.scope(video.id, scopeOpts);
  const downloadRef = download.addNode(scope, ports, {
    kind: NodeKind.Download,
    videoId: video.id,
  });
  const transcribeRef = transcribe.addNode(scope, ports, {
    kind: NodeKind.Transcribe,
    videoId: video.id,
    deps: { download: downloadRef },
  });
  const thumbnailRef = thumbnail.addNode(scope, ports, {
    kind: NodeKind.Thumbnail,
    videoId: video.id,
    deps: { download: downloadRef },
  });
  const chaptersRef = chapters(config.chapterPrompt).addNode(scope, ports, {
    kind: NodeKind.Chapters,
    videoId: video.id,
    deps: { download: downloadRef, transcribe: transcribeRef },
  });
  const embedChaptersRef = embedChapters.addNode(scope, ports, {
    kind: NodeKind.EmbedChapters,
    videoId: video.id,
    deps: { download: downloadRef, chapters: chaptersRef },
  });
  const deps: RssEntryParams["deps"] = {
    download: downloadRef,
    transcribe: transcribeRef,
    thumbnail: thumbnailRef,
    chapters: chaptersRef,
    embedChapters: embedChaptersRef,
  };
  if (config.summaryPrompt) {
    deps.summary = summary(config.summaryPrompt).addNode(scope, ports, {
      kind: NodeKind.Summary,
      videoId: video.id,
      deps: { download: downloadRef, transcribe: transcribeRef },
    });
  }
  return rssEntry.addNode(scope, ports, {
    kind: NodeKind.RssEntry,
    videoId: video.id,
    deps,
  });
}

export interface PipelineRefs {
  entryRefs: NodeRefOf<rssEntry>[];
  artworkRef: NodeRefOf<artwork>;
}

export function buildPipelineGraph(
  videos: VideoInfo[],
  ports: Ports,
  config: Config,
): { graph: Graph; refs: PipelineRefs } {
  const graph = new Graph();
  const sorted = [...videos].sort((a, b) => b.uploadDate.localeCompare(a.uploadDate));
  const entryRefs = sorted.map((video, i) =>
    addVideoSubgraph(graph, video, ports, config, { priority: sorted.length - i }),
  );

  const avatarRef = channelAvatar.addNode(graph, ports, {
    kind: NodeKind.ChannelAvatar,
    channelUrl: config.channelUrl,
  });
  const artworkRef = artwork.addNode(graph, ports, {
    kind: NodeKind.Artwork,
    deps: { channelAvatar: avatarRef },
  });
  return {
    graph,
    refs: { entryRefs, artworkRef },
  };
}

export function videoPipelineTopology(ports: Ports, config: Config): KindEdge[] {
  const dummy: VideoInfo = { id: "_topo", uploadDate: "00000000", title: "" };
  const graph = buildVideoGraph(dummy, ports, config);
  return graph.kindTopology();
}
