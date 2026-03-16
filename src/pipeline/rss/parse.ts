import { XMLParser } from "fast-xml-parser";

import type { Chapter, Episode } from "@/types";

const xmlParserOptions = {
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
};

function parseUploadDate(pubDateStr: string): string {
  const d = new Date(pubDateStr);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

function parseDuration(durationStr: string): number {
  const parts = durationStr.split(":");
  if (parts.length === 3) return parseInt(parts[0]!, 10) * 3600 + parseInt(parts[1]!, 10) * 60 + parseInt(parts[2]!, 10);
  if (parts.length === 2) return parseInt(parts[0]!, 10) * 60 + parseInt(parts[1]!, 10);
  return 0;
}

export function parseExistingFeed(baseUrl: string, xml: string): Episode[] {
  const parser = new XMLParser(xmlParserOptions);
  const parsed = parser.parse(xml);
  const channel = parsed?.rss?.channel;
  if (!channel) return [];
  const items = Array.isArray(channel.item) ? channel.item : channel.item ? [channel.item] : [];
  const episodes: Episode[] = [];
  for (const item of items) {
    const guid = typeof item.guid === "object" ? item.guid["#text"] : item.guid;
    const enclosure = item.enclosure;
    if (!guid || !enclosure) continue;
    const encUrl = enclosure["@_url"] || "";
    const fileSize = parseInt(enclosure["@_length"] || "0", 10);
    const filename = decodeURIComponent(encUrl.replace(baseUrl + "/", ""));
    const uploadDate = item.pubDate ? parseUploadDate(item.pubDate) : "";
    const duration = item["itunes:duration"] ? parseDuration(item["itunes:duration"]) : 0;
    let thumbnail: string = "";
    const itunesImage = item["itunes:image"];
    if (itunesImage) {
      const href = typeof itunesImage === "object" ? itunesImage["@_href"] : itunesImage;
      if (href) thumbnail = decodeURIComponent(href.replace(baseUrl + "/", ""));
    }
    let transcript: string | null = null;
    const podcastTranscript = item["podcast:transcript"];
    if (podcastTranscript) {
      const url = podcastTranscript["@_url"];
      if (url) transcript = decodeURIComponent(url.replace(baseUrl + "/", ""));
    }
    episodes.push({
      id: guid,
      title: item.title || "",
      description: item.description || "",
      uploadDate,
      duration,
      filename,
      fileSize,
      resolvedLinks: {},
      summary: null,
      thumbnail,
      chaptersGenerated: false,
      chapters: item["podcast:chapters"]
        ? [{ startTime: 0, endTime: 0, title: "" } satisfies Chapter]
        : [],
      transcript,
    });
  }
  return episodes;
}

export function extractReferencedUrls(xml: string): string[] {
  const parser = new XMLParser(xmlParserOptions);
  const feed = parser.parse(xml);
  const channel = feed.rss.channel;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items: Record<string, any>[] = Array.isArray(channel.item)
    ? channel.item
    : channel.item
      ? [channel.item]
      : [];
  const urls: string[] = [channel.image?.url, channel["itunes:image"]?.["@_href"]];
  for (const item of items) {
    urls.push(item.enclosure?.["@_url"]);
    urls.push(item["itunes:image"]?.["@_href"]);
    urls.push(item["media:content"]?.["@_url"]);
    urls.push(item["podcast:chapters"]?.["@_url"]);
    urls.push(item["podcast:transcript"]?.["@_url"]);
  }
  return [...new Set(urls.filter(Boolean))];
}

export function mergeEpisodes(existing: Episode[], newEps: Episode[]): Episode[] {
  const byId = new Map<string, Episode>();
  for (const ep of existing) byId.set(ep.id, ep);
  for (const ep of newEps) byId.set(ep.id, ep);
  return Array.from(byId.values()).sort((a, b) => b.uploadDate.localeCompare(a.uploadDate));
}
