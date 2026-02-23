import type { Ports } from "@/ports/types";
import { defineAction, type ActionDef, type ActionSpec, type BaseParams, type Outputs } from "@podpiper/dagraph";

export function defineActionWithPorts<P extends BaseParams, R extends Outputs, C = string>(
  spec: ActionSpec<Ports, P, R, C>,
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
