import type { Ports } from "@/ports/types";
import type { Config, VideoInfo } from "@/types";
import { Graph, type KindEdge, type NodeRefOf } from "@podpiper/dagraph";

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
): NodeRefOf<rssEntry> {
  const dl = download.addNode(graph, ports, {
    kind: NodeKind.Download,
    videoId: video.id,
  });
  const tr = transcribe.addNode(graph, ports, {
    kind: NodeKind.Transcribe,
    videoId: video.id,
    deps: { download: dl },
  });
  const th = thumbnail.addNode(graph, ports, {
    kind: NodeKind.Thumbnail,
    videoId: video.id,
    deps: { download: dl },
  });
  const ch = chapters(config.chapterPrompt).addNode(graph, ports, {
    kind: NodeKind.Chapters,
    videoId: video.id,
    deps: { download: dl, transcribe: tr },
  });
  const ec = embedChapters.addNode(graph, ports, {
    kind: NodeKind.EmbedChapters,
    videoId: video.id,
    deps: { download: dl, chapters: ch },
  });
  const deps: RssEntryParams["deps"] = {
    download: dl,
    transcribe: tr,
    thumbnail: th,
    chapters: ch,
    embedChapters: ec,
  };
  if (config.summaryPrompt) {
    deps.summary = summary(config.summaryPrompt).addNode(graph, ports, {
      kind: NodeKind.Summary,
      videoId: video.id,
      deps: { download: dl, transcribe: tr },
    });
  }
  return rssEntry.addNode(graph, ports, {
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
  const entryRefs = videos.map((video) => addVideoSubgraph(graph, video, ports, config));
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
