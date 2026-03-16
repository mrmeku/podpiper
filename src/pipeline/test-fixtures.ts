import { createMemoryFs } from "@/ports/memory-fs";
import { createSpyPorts } from "@/ports/mock";
import type { Config, VideoInfo, YtDlpInfo } from "@/types";

export const TEST_CONFIG: Config = {
  channelUrl: "https://www.youtube.com/@testchannel",
  outputDir: "/test/output",
  storage: { bucket: "test-bucket", publicUrl: "https://cdn.test.com" },
  podcast: {
    title: "Test Podcast",
    author: "Test Author",
    description: "A test podcast",
    category: "Technology",
    ownerEmail: "test@example.com",
    copyright: "Test Author",
  },
  summaryPrompt: "Summarize this episode concisely.",
};

export const TEST_VIDEOS: VideoInfo[] = [
  { id: "vid_aaa", uploadDate: "20240315", title: "Video AAA" },
  { id: "vid_bbb", uploadDate: "20240310", title: "Video BBB" },
];

export const VID_AAA_INFO: YtDlpInfo = {
  id: "vid_aaa",
  title: "Understanding Deep Learning",
  description: "A video about deep learning.",
  upload_date: "20240315",
  duration: 1800,
  chapters: [
    { start_time: 0, end_time: 600, title: "Introduction" },
    { start_time: 600, end_time: 1200, title: "Core Concepts" },
    { start_time: 1200, end_time: 1800, title: "Conclusion" },
  ],
};

export const VID_BBB_INFO: YtDlpInfo = {
  id: "vid_bbb",
  title: "Growth Mindset Tips",
  description: "A video about growth mindset.",
  upload_date: "20240310",
  duration: 2400,
};

export const VID_CCC_INFO: YtDlpInfo = {
  id: "vid_ccc",
  title: "Intro to Rust Programming",
  description: "A video about Rust programming.",
  upload_date: "20240320",
  duration: 3600,
};

export function createTestPorts(existingFs?: ReturnType<typeof createMemoryFs>) {
  const fs = existingFs ?? createMemoryFs();
  const ports = createSpyPorts(fs, {
    ytdlp: {
      fetchVideoList: async () => [],
      fetchVideoTitles: async () => ({}),
      downloadVideo: async (outputDir: string, videoId: string) => {
        const infoMap: Record<string, YtDlpInfo> = {
          vid_aaa: VID_AAA_INFO,
          vid_bbb: VID_BBB_INFO,
          vid_ccc: VID_CCC_INFO,
        };
        const info = infoMap[videoId] ?? VID_BBB_INFO;
        await fs.writeText(`${outputDir}/audio.mp3`, `fake-mp3-${videoId}`);
        await fs.writeText(`${outputDir}/audio.info.json`, JSON.stringify(info));
        await fs.writeText(`${outputDir}/audio.jpg`, `fake-thumb-${videoId}`);
      },
      downloadChannelArtwork: async (outputDir: string) => {
        await fs.writeText(`${outputDir}/channel_avatar.jpg`, "fake-avatar");
      },
    },
  });
  return { fs, ports };
}
