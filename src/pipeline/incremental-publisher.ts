import { publish, reconcilePublish, type PublishInput } from "@/pipeline/publish";
import type { FileSystem, ObjectStore } from "@/ports/types";
import { readJson } from "@/typed-path";
import type { Config, Episode, UploadEntry } from "@/types";
import type { ExecAction, OutputOf } from "@podpiper/dagraph";
import { Subject, bufferTime, concatMap, filter, lastValueFrom } from "rxjs";
import { NodeKind } from "./actions/define-action";
import type { artwork } from "./actions/artwork";
import type { rssEntry } from "./actions/rss-entry";

const BUFFER_INTERVAL_MS = 30_000;

type DoneAction = Extract<ExecAction, { type: "done" }>;

async function collectEpisode(
  action: DoneAction,
  fs: FileSystem,
): Promise<{ episode: Episode; uploads: UploadEntry[] }> {
  const outputs = action.outputs as OutputOf<rssEntry>;
  const episode = await readJson(fs, outputs.episode);
  const uploads = await readJson(fs, outputs.uploads);
  return { episode, uploads };
}

async function collectArtworkUploads(
  action: DoneAction,
  fs: FileSystem,
): Promise<UploadEntry[]> {
  const uploadsPath = action.outputs as OutputOf<artwork>;
  return readJson(fs, uploadsPath);
}

async function collectBatch(
  actions: DoneAction[],
  fs: FileSystem,
): Promise<PublishInput> {
  const uploads: UploadEntry[] = [];
  const episodes: Episode[] = [];
  for (const action of actions) {
    switch (action.node.kind) {
      case NodeKind.RssEntry: {
        const result = await collectEpisode(action, fs);
        episodes.push(result.episode);
        uploads.push(...result.uploads);
        break;
      }
      case NodeKind.Artwork:
        uploads.push(...(await collectArtworkUploads(action, fs)));
        break;
    }
  }
  return { uploads, episodes };
}

export interface IncrementalPublisher {
  onAction: (action: ExecAction) => void;
  flush: (final: PublishInput) => Promise<void>;
}

export function createIncrementalPublisher(
  config: Config,
  fs: FileSystem,
  storage: ObjectStore,
  bufferMs = BUFFER_INTERVAL_MS,
): IncrementalPublisher {
  const subject = new Subject<DoneAction>();

  const completion = lastValueFrom(
    subject.pipe(
      filter((a) => a.node.kind === NodeKind.RssEntry || a.node.kind === NodeKind.Artwork),
      bufferTime(bufferMs),
      filter((batch) => batch.length > 0),
      concatMap(async (batch) => {
        const input = await collectBatch(batch, fs);
        await publish(input, config, fs, storage);
      }),
    ),
    { defaultValue: undefined },
  );

  return {
    onAction: (action: ExecAction) => {
      if (action.type === "done") subject.next(action);
    },
    flush: async (final: PublishInput) => {
      subject.complete();
      await completion;
      await reconcilePublish(final, config, fs, storage);
    },
  };
}
