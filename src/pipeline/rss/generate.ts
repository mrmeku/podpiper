import { XMLBuilder } from "fast-xml-parser";

import type { Chapter, Config, Episode } from "@/types";

const xmlBuilderOptions = {
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  cdataPropName: "__cdata",
  format: true,
  indentBy: "  ",
  suppressEmptyNode: true,
};

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function formatRfc2822(d: Date): string {
  const day = DAYS[d.getUTCDay()];
  const dd = d.getUTCDate().toString().padStart(2, "0");
  const mon = MONTHS[d.getUTCMonth()];
  const yyyy = d.getUTCFullYear();
  const hh = d.getUTCHours().toString().padStart(2, "0");
  const mm = d.getUTCMinutes().toString().padStart(2, "0");
  const ss = d.getUTCSeconds().toString().padStart(2, "0");
  return `${day}, ${dd} ${mon} ${yyyy} ${hh}:${mm}:${ss} GMT`;
}

function formatPubDate(uploadDate: string): string {
  const d = new Date(
    `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}`,
  );
  return formatRfc2822(d);
}

function encodeUrl(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatChaptersText(chapters: Chapter[]): string {
  return chapters.map((ch) => `${formatTimestamp(ch.startTime)} — ${ch.title}`).join("\n");
}

function buildDescription(ep: Episode): string {
  const parts = [ep.description];
  if (ep.chapters.length > 0) {
    const label = ep.chaptersGenerated ? "— Generated Chapters —" : "— Chapters —";
    parts.push(`${label}\n${formatChaptersText(ep.chapters)}`);
  }
  if (ep.summary)
    parts.push(`— Generated Summary —\n${ep.summary}`);
  return parts.join("\n\n");
}

function descriptionToHtml(text: string): string {
  return text
    .split(/\n\n+/)
    .filter(Boolean)
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

interface RssItem {
  title: string;
  description: string;
  "content:encoded": { __cdata: string };
  pubDate: string;
  guid: { "#text": string; "@_isPermaLink": string };
  link: string;
  enclosure: { "@_url": string; "@_length": number | undefined; "@_type": string };
  "itunes:duration": string | undefined;
  "itunes:episodeType": string;
  "itunes:explicit": string;
  "itunes:author": string;
  "itunes:title": string;
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
    description: buildDescription(ep),
    "content:encoded": { __cdata: descriptionToHtml(buildDescription(ep)) },
    pubDate: formatPubDate(ep.uploadDate),
    guid: { "#text": ep.id, "@_isPermaLink": "false" },
    link: `https://www.youtube.com/watch?v=${ep.id}`,
    enclosure: {
      "@_url": `${config.storage.publicUrl}/${encodeUrl(ep.filename)}`,
      "@_length": ep.fileSize,
      "@_type": "audio/mpeg",
    },
    "itunes:duration": ep.duration ? formatDuration(ep.duration) : undefined,
    "itunes:episodeType": "full",
    "itunes:explicit": config.podcast.explicit ? "true" : "false",
    "itunes:author": config.podcast.author,
    "itunes:title": ep.title,
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
        "@_url": `${config.storage.publicUrl}/${encodeUrl(`${ep.id}/chapters.json`)}`,
        "@_type": "application/json+chapters",
      },
    }),
    ...(ep.transcript && {
      "podcast:transcript": {
        "@_url": `${config.storage.publicUrl}/${encodeUrl(ep.transcript)}`,
        "@_type": "text/srt",
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
      "@_xmlns:atom": "http://www.w3.org/2005/Atom",
      "@_xmlns:content": "http://purl.org/rss/1.0/modules/content/",
      "@_xmlns:itunes": "http://www.itunes.com/dtds/podcast-1.0.dtd",
      "@_xmlns:media": "http://search.yahoo.com/mrss/",
      "@_xmlns:podcast": "https://podcastindex.org/namespace/1.0",
      channel: {
        title: podcast.title,
        description: podcast.description,
        link: config.channelUrl,
        "atom:link": {
          "@_href": `${config.storage.publicUrl}/feed.xml`,
          "@_rel": "self",
          "@_type": "application/rss+xml",
        },
        language: podcast.language ?? "en",
        ...(podcast.copyright && { copyright: podcast.copyright }),
        pubDate: newestEpisode ? formatPubDate(newestEpisode.uploadDate) : undefined,
        lastBuildDate: formatRfc2822(new Date()),
        ttl: 60,
        generator: "podpiper",
        image: {
          url: artworkUrl,
          title: podcast.title,
          link: config.channelUrl,
        },
        "itunes:author": podcast.author,
        "itunes:explicit": podcast.explicit ? "true" : "false",
        "itunes:image": { "@_href": artworkUrl },
        "itunes:category": categoryObj,
        "itunes:type": "episodic",
        ...(podcast.ownerEmail && {
          "itunes:owner": {
            "itunes:name": podcast.author,
            "itunes:email": podcast.ownerEmail,
          },
        }),
        "podcast:medium": "podcast",
        "podcast:person": { "#text": podcast.author, "@_role": "host" },
        item: items,
      },
    },
  };
  return builder.build(feedObj);
}
