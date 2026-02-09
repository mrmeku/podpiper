import type { Graph } from "@/dag/graph";
import type { Node } from "@/dag/types";
import type { NodeKind } from "@/pipeline/actions/define-action";

const NODE_LABELS: Record<NodeKind, string> = {
  download: "yt-dlp: download",
  transcribe: "whisper: transcribe",
  thumbnail: "ffmpeg: thumbnail",
  chapters: "claude: chapters",
  summary: "claude: summary",
  rss_entry: "rss entry",
  channel_avatar: "yt-dlp: avatar",
  artwork: "ffmpeg: artwork",
};

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
  lines.push(`  subgraph discovery_phase ["Copper: Discovery"]`);
  lines.push(`    discovery["yt-dlp: fetch videos"]`);
  lines.push(`  end`);
  if (downloadIds.length) {
    lines.push(`  discovery --> ${downloadIds.join(" & ")}`);
  }

  // pipeline phase
  lines.push("");
  lines.push(`  subgraph pipeline_phase ["Silver: Pipeline"]`);
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
  lines.push(`  subgraph publish_phase ["Gold: Publish"]`);
  lines.push(`    publish["R2 Uploads + Feed"]`);
  lines.push(`  end`);
  if (publishDeps.length) {
    lines.push(`  ${publishDeps.join(" & ")} --> publish`);
  }

  // phase colors
  lines.push("");
  lines.push(`  style discovery_phase fill:#f4d3a0,stroke:#c48540,color:#5c3a1a`);
  lines.push(`  style pipeline_phase fill:#e8e8e8,stroke:#999,color:#333`);
  lines.push(`  style publish_phase fill:#fef3c7,stroke:#d4a017,color:#5c4a00`);
  for (let i = 1; i <= videoGroups.size; i++) {
    lines.push(`  style video_${i} fill:#ede4f5,stroke:#9b72cf,color:#3b2456`);
  }

  return lines.join("\n");
}
