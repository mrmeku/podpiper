export type ApplePodcastCategory =
  | {
      category: "Arts";
      subcategory?:
        | "Books"
        | "Design"
        | "Fashion & Beauty"
        | "Food"
        | "Performing Arts"
        | "Visual Arts";
    }
  | {
      category: "Business";
      subcategory?:
        | "Careers"
        | "Entrepreneurship"
        | "Investing"
        | "Management"
        | "Marketing"
        | "Non-Profit";
    }
  | {
      category: "Comedy";
      subcategory?: "Comedy Interviews" | "Improv" | "Stand-Up";
    }
  | {
      category: "Education";
      subcategory?: "Courses" | "How To" | "Language Learning" | "Self-Improvement";
    }
  | {
      category: "Fiction";
      subcategory?: "Comedy Fiction" | "Drama" | "Science Fiction";
    }
  | { category: "Government"; subcategory?: never }
  | { category: "History"; subcategory?: never }
  | {
      category: "Health & Fitness";
      subcategory?:
        | "Alternative Health"
        | "Fitness"
        | "Medicine"
        | "Mental Health"
        | "Nutrition"
        | "Sexuality";
    }
  | {
      category: "Kids & Family";
      subcategory?: "Education for Kids" | "Parenting" | "Pets & Animals" | "Stories for Kids";
    }
  | {
      category: "Leisure";
      subcategory?:
        | "Animation & Manga"
        | "Automotive"
        | "Aviation"
        | "Crafts"
        | "Games"
        | "Hobbies"
        | "Home & Garden"
        | "Video Games";
    }
  | {
      category: "Music";
      subcategory?: "Music Commentary" | "Music History" | "Music Interviews";
    }
  | {
      category: "News";
      subcategory?:
        | "Business News"
        | "Daily News"
        | "Entertainment News"
        | "News Commentary"
        | "Politics"
        | "Sports News"
        | "Tech News";
    }
  | {
      category: "Religion & Spirituality";
      subcategory?:
        | "Buddhism"
        | "Christianity"
        | "Hinduism"
        | "Islam"
        | "Judaism"
        | "Religion"
        | "Spirituality";
    }
  | {
      category: "Science";
      subcategory?:
        | "Astronomy"
        | "Chemistry"
        | "Earth Sciences"
        | "Life Sciences"
        | "Mathematics"
        | "Natural Sciences"
        | "Nature"
        | "Physics"
        | "Social Sciences";
    }
  | {
      category: "Society & Culture";
      subcategory?:
        | "Documentary"
        | "Personal Journals"
        | "Philosophy"
        | "Places & Travel"
        | "Relationships";
    }
  | {
      category: "Sports";
      subcategory?:
        | "Baseball"
        | "Basketball"
        | "Cricket"
        | "Fantasy Sports"
        | "Football"
        | "Golf"
        | "Hockey"
        | "Rugby"
        | "Running"
        | "Soccer"
        | "Swimming"
        | "Tennis"
        | "Volleyball"
        | "Wilderness"
        | "Wrestling";
    }
  | { category: "Technology"; subcategory?: never }
  | { category: "True Crime"; subcategory?: never }
  | {
      category: "TV & Film";
      subcategory?:
        | "After Shows"
        | "Film History"
        | "Film Interviews"
        | "Film Reviews"
        | "TV Reviews";
    };

export type PodcastConfig = {
  title: string;
  author: string;
  description: string;
  ownerEmail?: string;
  copyright?: string;
  language?: string;
  explicit?: boolean;
} & ApplePodcastCategory;

export interface StorageConfig {
  bucket: string;
  publicUrl: string;
}

export interface Config {
  channelUrl: string;
  outputDir: string;
  casBaseDir: string;
  storage: StorageConfig;
  podcast: PodcastConfig;
  summaryPrompt?: string;
  chapterPrompt?: string;
  startDate?: string;
}

export interface VideoInfo {
  id: string;
  uploadDate: string;
  title: string;
}

export interface YtDlpChapter {
  start_time: number;
  end_time: number;
  title: string;
}

export interface YtDlpInfo {
  id: string;
  title: string;
  description?: string;
  upload_date: string;
  duration?: number;
  chapters?: YtDlpChapter[];
}

export interface Chapter {
  startTime: number;
  endTime: number;
  title: string;
}

export interface ChaptersResult {
  chapters: Chapter[];
  generated: boolean;
}

export interface Episode {
  chapters: Chapter[];
  chaptersGenerated: boolean;
  description: string;
  duration: number | undefined;
  filename: string;
  fileSize: number | undefined;
  id: string;
  resolvedLinks: Record<string, string>;
  summary: string | null;
  thumbnail: string;
  title: string;
  transcript: string | null;
  uploadDate: string;
}

export interface WhisperSegment {
  timestamps: { from: string; to: string };
  offsets: { from: number; to: number };
  text: string;
}

export interface WhisperJson {
  transcription: WhisperSegment[];
}

export interface UploadEntry {
  localPath: string;
  key: string;
  cacheControl?: string;
}

export interface HasUploads {
  uploads: UploadEntry[];
}
