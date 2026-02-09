import type { Ports } from "@/ports/types";
import type { ActionDef, ActionSpec } from "@podpiper/dag/define-action";
import { defineAction } from "@podpiper/dag/define-action";
import type { BaseParams } from "@podpiper/dag/types";

export function defineActionWithPorts<P extends BaseParams, R>(
  spec: ActionSpec<Ports, P, R>,
): ActionDef<Ports, P, R> {
  return defineAction(spec);
}

export enum NodeKind {
  Download = "download",
  Transcribe = "transcribe",
  Thumbnail = "thumbnail",
  Chapters = "chapters",
  Summary = "summary",
  RssEntry = "rss_entry",
  ChannelAvatar = "channel_avatar",
  Artwork = "artwork",
}

export function toVideoActionName<P extends { kind: NodeKind; videoId: string }>(p: P) {
  return `${p.kind}:${p.videoId}`;
}

export function toVideoDir(outputDir: string, videoId: string): string {
  return `${outputDir}/videos/${videoId}`;
}
