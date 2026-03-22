import { NodeKind } from "@/pipeline/actions/define-action";

export const TASK_QUEUES = {
  workflows: "podpiper-workflows",
  default: "podpiper-default",
  whisper: "podpiper-whisper",
  claude: "podpiper-claude",
} as const;

export interface TemporalTaskConfig {
  taskQueue: string;
  startToCloseTimeout: string;
  scheduleToCloseTimeout?: string;
  retry?: {
    maximumAttempts?: number;
    backoffCoefficient?: number;
    maximumInterval?: string;
  };
}

export const TEMPORAL_TASK_CONFIG: Record<NodeKind, TemporalTaskConfig> = {
  [NodeKind.Download]: {
    taskQueue: TASK_QUEUES.default,
    startToCloseTimeout: "30m",
    retry: { maximumAttempts: 4, backoffCoefficient: 2, maximumInterval: "30s" },
  },
  [NodeKind.Transcribe]: {
    taskQueue: TASK_QUEUES.whisper,
    startToCloseTimeout: "15m",
    retry: { maximumAttempts: 3, backoffCoefficient: 2 },
  },
  [NodeKind.Thumbnail]: {
    taskQueue: TASK_QUEUES.default,
    startToCloseTimeout: "30s",
    retry: { maximumAttempts: 2 },
  },
  [NodeKind.Chapters]: {
    taskQueue: TASK_QUEUES.claude,
    startToCloseTimeout: "2m",
    scheduleToCloseTimeout: "30m",
    retry: { maximumAttempts: 3, backoffCoefficient: 3, maximumInterval: "2m" },
  },
  [NodeKind.EmbedChapters]: {
    taskQueue: TASK_QUEUES.default,
    startToCloseTimeout: "2m",
    retry: { maximumAttempts: 2 },
  },
  [NodeKind.Summary]: {
    taskQueue: TASK_QUEUES.claude,
    startToCloseTimeout: "2m",
    scheduleToCloseTimeout: "30m",
    retry: { maximumAttempts: 3, backoffCoefficient: 3, maximumInterval: "2m" },
  },
  [NodeKind.RssEntry]: {
    taskQueue: TASK_QUEUES.default,
    startToCloseTimeout: "30s",
  },
  [NodeKind.ChannelAvatar]: {
    taskQueue: TASK_QUEUES.default,
    startToCloseTimeout: "5m",
    retry: { maximumAttempts: 4 },
  },
  [NodeKind.Artwork]: {
    taskQueue: TASK_QUEUES.default,
    startToCloseTimeout: "2m",
  },
};
