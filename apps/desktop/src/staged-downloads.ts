import { join } from "node:path";
import type { DownloadExecutorResult } from "electron-updater/out/AppUpdater.js";
import { DownloadedUpdateHelper } from "electron-updater/out/DownloadedUpdateHelper.js";

/** electron-updater clears pending on failure. Keep the installable helper in the other slot. */
export class StagedDownloads {
  private cache?: string;

  async run(
    previous: DownloadedUpdateHelper | null,
    select: (helper: DownloadedUpdateHelper) => void,
    download: () => Promise<DownloadExecutorResult>,
  ): Promise<DownloadExecutorResult> {
    if (!previous?.file) return download();
    this.cache ??= previous.cacheDir;

    const candidate = new DownloadedUpdateHelper(
      previous.cacheDir === this.cache ? join(this.cache, "replacement") : this.cache,
    );

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
