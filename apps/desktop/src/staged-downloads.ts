import { join } from "node:path";
import { CancellationError } from "builder-util-runtime";
import type { DownloadExecutorResult, DownloadExecutorTask } from "electron-updater/out/AppUpdater.js";
import { DownloadedUpdateHelper } from "electron-updater/out/DownloadedUpdateHelper.js";

/** Cancelled attempts must not commit files or replace the native macOS feed when they settle late. */
export function cancellable(task: DownloadExecutorTask): DownloadExecutorTask {
  const check = () => {
    if (task.downloadUpdateOptions.cancellationToken.cancelled) throw new CancellationError();
  };

  return {
    ...task,
    task: async (...args) => {
      check();
      await task.task(...args);
      check();
    },
    done: async (event) => {
      check();
      await task.done?.(event);
      check();
    },
  };
}

/** electron-updater clears pending on failure. Keep the installable helper in the other slot. */
export class StagedDownloads {
  private cache?: string;

  constructor(
    private readonly replacement = (previous: DownloadedUpdateHelper, root: string) =>
      new DownloadedUpdateHelper(previous.cacheDir === root ? join(root, "replacement") : root),
  ) {}

  async run(
    previous: DownloadedUpdateHelper | null,
    select: (helper: DownloadedUpdateHelper) => void,
    download: () => Promise<DownloadExecutorResult>,
  ): Promise<DownloadExecutorResult> {
    if (!previous?.file) return download();
    this.cache ??= previous.cacheDir;

    const candidate = this.replacement(previous, this.cache);

    select(candidate);

    try {
      const result = await download();
      await previous.clear();

      return result;
    } catch (error) {
      select(previous);
      await candidate.clear();

      throw error;
    }
  }
}
