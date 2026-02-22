import { XMLBuilder } from "fast-xml-parser";

import type { Config, Episode } from "@/types";

const xmlBuilderOptions = {
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  format: true,
  indentBy: "  ",
  suppressEmptyNode: true,
};

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function formatPubDate(uploadDate: string): string {
  const d = new Date(
    `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}`,
  );
  return d.toUTCString();
}

function encodeUrl(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

interface RssItem {
  title: string;
  description: string;
  pubDate: string;
  guid: { "#text": string; "@_isPermaLink": string };
  enclosure: { "@_url": string; "@_length": number | undefined; "@_type": string };
  "itunes:duration": string | undefined;
  "itunes:image"?: { "@_href": string };
  "media:content"?: { "@_url": string; "@_medium": string; "@_type": string };
  "podcast:chapters"?: { "@_url": string; "@_type": string };
  "podcast:transcript"?: { "@_url": string; "@_type": string };
  "podcast:contentLink"?: { "#text": string; "@_href": string };
}

function buildItem(config: Config, ep: Episode): RssItem {
  const thumbUrl = ep.thumbnail ? `${config.storage.publicUrl}/${encodeUrl(ep.thumbnail)}` : null;
  const hasChapters = ep.chapters.length > 0;
  return {
    title: ep.title,
    description: ep.description,
    pubDate: formatPubDate(ep.uploadDate),
    guid: { "#text": ep.id, "@_isPermaLink": "false" },
    enclosure: {
      "@_url": `${config.storage.publicUrl}/${encodeUrl(ep.filename)}`,
      "@_length": ep.fileSize,
      "@_type": "audio/mpeg",
    },
    "itunes:duration": ep.duration ? formatDuration(ep.duration) : undefined,
    ...(thumbUrl && {
      "itunes:image": { "@_href": thumbUrl },
      "media:content": {
        "@_url": thumbUrl,
        "@_medium": "image",
        "@_type": "image/jpeg",
      },
    }),
    ...(hasChapters && {
      "podcast:chapters": {
        "@_url": `${config.storage.publicUrl}/${ep.id}/chapters.json`,
        "@_type": "application/json+chapters",
      },
    }),
    ...(ep.transcript && {
      "podcast:transcript": {
        "@_url": `${config.storage.publicUrl}/${encodeUrl(ep.transcript)}`,
        "@_type": "application/srt",
      },
    }),
    "podcast:contentLink": {
      "#text": "Watch on YouTube",
      "@_href": `https://www.youtube.com/watch?v=${ep.id}`,
    },
  };
}

export function buildFeedXml(config: Config, episodes: Episode[]): string {
  const { podcast } = config;
  const artworkUrl = `${config.storage.publicUrl}/artwork.jpg`;
  const builder = new XMLBuilder(xmlBuilderOptions);
  const items = episodes.map((ep) => buildItem(config, ep));
  const newestEpisode = episodes[0];
  const categoryObj = podcast.subcategory
    ? {
        "@_text": podcast.category,
        "itunes:category": { "@_text": podcast.subcategory },
      }
    : { "@_text": podcast.category };
  const feedObj = {
    "?xml": { "@_version": "1.0", "@_encoding": "UTF-8" },
    rss: {
      "@_version": "2.0",
      "@_xmlns:itunes": "http://www.itunes.com/dtds/podcast-1.0.dtd",
      "@_xmlns:media": "http://search.yahoo.com/mrss/",
      "@_xmlns:podcast": "https://podcastindex.org/namespace/1.0",
      channel: {
        title: podcast.title,
        description: podcast.description,
        link: config.channelUrl,
        language: "en",
        pubDate: newestEpisode ? formatPubDate(newestEpisode.uploadDate) : undefined,
        lastBuildDate: new Date().toUTCString(),
        ttl: 60,
        image: {
          url: artworkUrl,
          title: podcast.title,
          link: config.channelUrl,
        },
        "itunes:author": podcast.author,
        "itunes:image": { "@_href": artworkUrl },
        "itunes:category": categoryObj,
        "itunes:explicit": "false",
        "itunes:type": "episodic",
        "podcast:medium": "podcast",
        "podcast:person": { "#text": podcast.author, "@_role": "host" },
        item: items,
      },
    },
  };
  return builder.build(feedObj);
}
