import type { Ports } from "@/ports/types";
import type { JsonPath } from "@/typed-path";
import type { Chapter, Config, UploadEntry, VideoInfo } from "@/types";
import type { ActionDef } from "@podpiper/dag/define-action";
import { Graph } from "@podpiper/dag/graph";
import type { KindEdge, NodeRef } from "@podpiper/dag/types";

import { artwork, channelAvatar } from "./actions/artwork";
import type { ChaptersParams } from "./actions/chapters";
import { chapters } from "./actions/chapters";
import { NodeKind } from "./actions/define-action";
import { download } from "./actions/download";
import type { RssEntryParams, RssEntryResult } from "./actions/rss-entry";
import { rssEntry } from "./actions/rss-entry";
import type { SummaryParams } from "./actions/summary";
import { summary } from "./actions/summary";
import { thumbnail } from "./actions/thumbnail";
import { transcribe } from "./actions/transcribe";

interface VideoActions {
  chapters: ActionDef<Ports, ChaptersParams, JsonPath<Chapter[]>>;
  summary?: ActionDef<Ports, SummaryParams, string> | undefined;
}

export function buildVideoGraph(video: VideoInfo, ports: Ports, config: Config): Graph {
  const graph = new Graph();
  addVideoSubgraph(graph, video, ports, config, videoActions(config));
  return graph;
}

function addVideoSubgraph(
  graph: Graph,
  video: VideoInfo,
  ports: Ports,
  config: Config,
  actions: VideoActions,
): NodeRef<RssEntryResult> {
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
  const ch = actions.chapters.addNode(graph, ports, {
    kind: NodeKind.Chapters,
    videoId: video.id,
    outputDir: config.outputDir,
    deps: { download: dl, transcribe: tr },
  });
  const deps: RssEntryParams["deps"] = {
    download: dl,
    transcribe: tr,
    thumbnail: th,
    chapters: ch,
  };
  if (actions.summary) {
    deps.summary = actions.summary.addNode(graph, ports, {
      kind: NodeKind.Summary,
      videoId: video.id,
      outputDir: config.outputDir,
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
  entryRefs: NodeRef<RssEntryResult>[];
  artworkRef: NodeRef<JsonPath<UploadEntry[]>>;
}

function videoActions(config: Config): VideoActions {
  return {
    chapters: chapters(config.chapterPrompt),
    summary: config.summaryPrompt ? summary(config.summaryPrompt) : undefined,
  };
}

export function buildPipelineGraph(
  videos: VideoInfo[],
  ports: Ports,
  config: Config,
): { graph: Graph; refs: PipelineRefs } {
  const graph = new Graph();
  const actions = videoActions(config);
  const entryRefs = videos.map((video) => addVideoSubgraph(graph, video, ports, config, actions));
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
    outputDir: config.outputDir,
    deps: { channel_avatar: avatarRef },
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
