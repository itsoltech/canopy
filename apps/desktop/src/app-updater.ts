import { AppImageUpdater, MacUpdater, NsisUpdater, type AppUpdater } from "electron-updater";
import type { DownloadExecutorTask } from "electron-updater/out/AppUpdater.js";
import type { UpdateDownloadedEvent } from "electron-updater";
import { StagedDownloads } from "./staged-downloads.ts";

class StagedMacUpdater extends MacUpdater {
  private readonly downloads = new StagedDownloads();
  protected override executeDownload(task: DownloadExecutorTask) {
    return this.downloads.run(
      this.downloadedUpdateHelper,
      (helper) => {
        this.downloadedUpdateHelper = helper;
      },
      async () => {
        // Finish cache writes before replacing Squirrel's proxy/feed for the previous ZIP.
        let downloaded: UpdateDownloadedEvent | undefined;

        const files = await super.executeDownload({
          ...task,
          done: async (event) => {
            downloaded = event;
          },
        });

        if (downloaded) await task.done?.(downloaded);

        return files;
      },
    );
  }
}

class StagedNsisUpdater extends NsisUpdater {
  private readonly downloads = new StagedDownloads();
  protected override executeDownload(task: DownloadExecutorTask) {
    return this.downloads.run(
      this.downloadedUpdateHelper,
      (helper) => {
        this.downloadedUpdateHelper = helper;
      },
      () => super.executeDownload(task),
    );
  }
}

class StagedAppImageUpdater extends AppImageUpdater {
  private readonly downloads = new StagedDownloads();
  protected override executeDownload(task: DownloadExecutorTask) {
    return this.downloads.run(
      this.downloadedUpdateHelper,
      (helper) => {
        this.downloadedUpdateHelper = helper;
      },
      () => super.executeDownload(task),
    );
  }
}

/** deb installations are disabled by DesktopUpdates and remain package-manager owned. */
export function createAppUpdater(): AppUpdater {
  if (process.platform === "darwin") return new StagedMacUpdater();

  if (process.platform === "win32") return new StagedNsisUpdater();

  return new StagedAppImageUpdater();
}
