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
