import { join } from "node:path";
import { DownloadedUpdateHelper } from "electron-updater/out/DownloadedUpdateHelper.js";

/** electron-updater 6.8.3 clears pending on failure. Keep the installable helper in the other slot. */
export class StagedDownloads {
  private cache?: string;

  async run(
    previous: DownloadedUpdateHelper | null,
    select: (helper: DownloadedUpdateHelper) => void,
    download: () => Promise<string[]>,
  ): Promise<string[]> {
    if (!previous?.file) return download();
    this.cache ??= previous.cacheDir;

    const candidate = new DownloadedUpdateHelper(
      previous.cacheDir === this.cache ? join(this.cache, "replacement") : this.cache,
    );

    select(candidate);

    try {
      const files = await download();
      await previous.clear();

      return files;
    } catch (error) {
      select(previous);
      await candidate.clear();

      throw error;
    }
  }
}
