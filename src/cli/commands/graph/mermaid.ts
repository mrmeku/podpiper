import { NodeKind } from "@/pipeline/actions/define-action";
import type { Graph, Node } from "@podpiper/dagraph";

const NODE_LABELS: Record<NodeKind, string> = {
  download: "yt-dlp: download",
  transcribe: "whisper: transcribe",
  thumbnail: "ffmpeg: thumbnail",
  chapters: "claude: generate chapters",
  embed_chapters: "id3: embed chapters",
  summary: "claude: summary",
  rss_entry: "rss entry",
  channel_avatar: "yt-dlp: avatar",
  artwork: "ffmpeg: artwork",
};

const YTDLP_KINDS: Set<NodeKind> = new Set([NodeKind.Download, NodeKind.ChannelAvatar]);

function toId(name: string): string {
  return name.replace(/:/g, "_");
}

function toLabel(kind: string): string {
  return NODE_LABELS[kind as NodeKind];
}

export function generateMermaid(graph: Graph): string {
  const nodes: Node[] = [...graph.getNodes().values()];
  const videoGroups = new Map<string, Node[]>();
  const topLevel: Node[] = [];
  for (const node of nodes) {
    const colon = node.name.indexOf(":");
    if (colon === -1) {
      topLevel.push(node);
    } else {
      const vid = node.name.slice(colon + 1);
      if (!videoGroups.has(vid)) videoGroups.set(vid, []);
      videoGroups.get(vid)!.push(node);
    }
  }

  const downloadIds: string[] = [];
  for (const group of videoGroups.values()) {
    for (const n of group) {
      if (n.name.startsWith("download:")) downloadIds.push(toId(n.name));
    }
  }

  const lines = ["graph TD"];

  // discovery phase
  lines.push(`  subgraph discovery_phase ["Discovery"]`);
  lines.push(`    discovery["yt-dlp: fetch videos"]`);
  lines.push(`  end`);
  if (downloadIds.length) {
    lines.push(`  discovery --> ${downloadIds.join(" & ")}`);
  }

  // pipeline phase
  lines.push("");
  lines.push(`  subgraph pipeline_phase ["Execution"]`);
  let videoIdx = 0;
  for (const [vid, group] of videoGroups) {
    videoIdx++;
    lines.push(`    subgraph video_${videoIdx} ["Video ${videoIdx}"]`);
    for (const n of group) {
      lines.push(`      ${toId(n.name)}["${toLabel(n.kind)}"]`);
    }
    for (const n of group) {
      const localDeps = n.deps.filter((d) => d.includes(":") && d.endsWith(vid));
      if (localDeps.length) {
        lines.push(`      ${localDeps.map(toId).join(" & ")} --> ${toId(n.name)}`);
      }
    }
    lines.push(`    end`);
  }
  for (const n of topLevel) {
    lines.push(`    ${toId(n.name)}["${toLabel(n.kind)}"]`);
  }
  for (const n of topLevel) {
    if (n.deps.length) {
      lines.push(`    ${n.deps.map(toId).join(" & ")} --> ${toId(n.name)}`);
    }
  }
  lines.push(`  end`);

  // publish phase
  const rssEntryIds = [...videoGroups.values()]
    .flatMap((group) => group.filter((n) => n.name.startsWith("rss_entry:")))
    .map((n) => toId(n.name));
  const artworkId = topLevel.find((n) => n.name === "artwork");
  const publishDeps = [...rssEntryIds, ...(artworkId ? [toId(artworkId.name)] : [])];
  lines.push("");
  lines.push(`  subgraph publish_phase ["Publish"]`);
  lines.push(`    publish["Upload + Feed"]`);
  lines.push(`  end`);
  if (publishDeps.length) {
    lines.push(`  ${publishDeps.join(" & ")} --> publish`);
  }

  // subgraph colors (light tints so nodes stand out)
  lines.push("");
  lines.push(`  style discovery_phase fill:#fef7ed,stroke:#e8a95b,color:#7c4d1a`);
  lines.push(`  style pipeline_phase fill:#f1f5f9,stroke:#94a3b8,color:#334155`);
  lines.push(`  style publish_phase fill:#fefce8,stroke:#d4a017,color:#5c4a00`);
  for (let i = 1; i <= videoGroups.size; i++) {
    lines.push(`  style video_${i} fill:#f5f3ff,stroke:#a78bfa,color:#4c1d95`);
  }

  // node colors: silver base, gold for publish, bronze for yt-dlp (applied last to override)
  const silverIds = ["discovery"];
  for (const node of nodes) {
    silverIds.push(toId(node.name));
  }
  for (const id of silverIds) {
    lines.push(`  style ${id} fill:#cbd5e1,stroke:#64748b,color:#0f172a`);
  }
  lines.push(`  style publish fill:#fbbf24,stroke:#b45309,color:#451a03`);
  const ytdlpIds = ["discovery"];
  for (const node of nodes) {
    if (YTDLP_KINDS.has(node.kind as NodeKind)) ytdlpIds.push(toId(node.name));
  }
  for (const id of ytdlpIds) {
    lines.push(`  style ${id} fill:#c2742f,stroke:#7c2d12,color:#fff`);
  }

  return lines.join("\n");
}
