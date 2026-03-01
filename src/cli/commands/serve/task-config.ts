import { NodeKind } from "@/pipeline/actions/define-action";
import type { CreateBaseTaskOpts } from "@hatchet-dev/typescript-sdk/v1";
import { RateLimitDuration } from "@hatchet-dev/typescript-sdk/protoc/workflows";

export type TaskConfig = Pick<
  CreateBaseTaskOpts,
  "retries" | "executionTimeout" | "scheduleTimeout" | "backoff" | "rateLimits" | "concurrency"
>;

// Claude Code CLI capacity — tune to match your usage tier.
// Both chapters and summary share this bucket since they hit the same CLI.
const CLAUDE_LIMIT = 5;
const CLAUDE_WINDOW = RateLimitDuration.MINUTE;
// Must exceed (expected_claude_tasks / CLAUDE_LIMIT) * window_duration.
// 30 new videos × 2 claude tasks each = 60 tasks ÷ 5/min = 12min queue drain.
const CLAUDE_SCHEDULE_TIMEOUT = "30m";

const claudeRateLimit = {
  staticKey: "claude-cli",
  units: 1,
  limit: CLAUDE_LIMIT,
  duration: CLAUDE_WINDOW,
};

const claudeTaskDefaults: TaskConfig = {
  executionTimeout: "2m",
  scheduleTimeout: CLAUDE_SCHEDULE_TIMEOUT,
  retries: 2,
  backoff: { factor: 3, maxSeconds: 120 },
  rateLimits: [claudeRateLimit],
};

export const TASK_CONFIG: Record<NodeKind, TaskConfig> = {
  [NodeKind.Download]: {
    executionTimeout: "5m",
    retries: 3,
    backoff: { factor: 2, maxSeconds: 30 },
  },
  [NodeKind.Transcribe]: {
    executionTimeout: "15m",
    retries: 1,
  },
  [NodeKind.Thumbnail]: {
    executionTimeout: "30s",
    retries: 1,
  },
  [NodeKind.Chapters]: { ...claudeTaskDefaults },
  [NodeKind.EmbedChapters]: {
    executionTimeout: "2m",
    retries: 1,
  },
  [NodeKind.Summary]: { ...claudeTaskDefaults },
  [NodeKind.RssEntry]: {
    executionTimeout: "30s",
  },
  [NodeKind.ChannelAvatar]: {
    executionTimeout: "5m",
    retries: 3,
  },
  [NodeKind.Artwork]: {
    executionTimeout: "2m",
  },
};
