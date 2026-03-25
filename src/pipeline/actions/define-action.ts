import type { Ports } from "@/ports/types";
import {
  defineAction,
  type Action,
  type BaseParams,
  type Outputs,
} from "@podpiper/dagraph";

export function defineActionWithPorts<P extends BaseParams, R extends Outputs, C = string>(
  spec: Parameters<typeof defineAction<Ports, P, R, C>>[0],
): Action<Ports, P, R> {
  return defineAction(spec);
}

export enum VideoNodeKind {
  Download = "download",
  Transcribe = "transcribe",
  Thumbnail = "thumbnail",
  Chapters = "chapters",
  EmbedChapters = "embed_chapters",
  Summary = "summary",
  RssEntry = "rss_entry",
}

export enum ChannelNodeKind {
  ChannelAvatar = "channel_avatar",
  Artwork = "artwork",
}

export type NodeKind = VideoNodeKind | ChannelNodeKind;
export const NodeKind = { ...VideoNodeKind, ...ChannelNodeKind } as const;
