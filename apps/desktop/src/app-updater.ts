import { AppImageUpdater, MacUpdater, type AppUpdater } from "electron-updater";
import type { DownloadExecutorTask } from "electron-updater/out/AppUpdater.js";
import type { UpdateDownloadedEvent } from "electron-updater";
import { cancellable, StagedDownloads } from "./staged-downloads.ts";
import { DownloadedUpdateHelper } from "electron-updater/out/DownloadedUpdateHelper.js";
import { StagedNsisUpdater } from "./staged-nsis-updater.ts";
import { app } from "electron";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { MacUpdateFeed } from "./mac-update-feed.ts";

class StagedMacUpdater extends MacUpdater {
  private readonly downloads = new StagedDownloads();
  private installFeed: MacUpdateFeed | undefined;
  constructor(directory?: string) {
    super();

    if (directory) this.downloadedUpdateHelper = new DownloadedUpdateHelper(directory);
  }
  protected override async executeDownload(task: DownloadExecutorTask) {
    task = cancellable(task);
    let installFeed: MacUpdateFeed | undefined;

    const result = await this.downloads.run(
      this.downloadedUpdateHelper,
      (helper) => {
        this.downloadedUpdateHelper = helper;
      },
      async () => {
        // Finish cache writes before replacing Squirrel's proxy/feed for the previous ZIP.
        let downloaded: UpdateDownloadedEvent | undefined;

        const result = await super.executeDownload({
          ...task,
          done: async (event) => {
            downloaded = event;
          },
        });

        if (downloaded) {
          const event = downloaded;

          const feed = new MacUpdateFeed(async () => {
            await task.done?.(event);
          });

          await feed.commit();
          installFeed = feed;
        }

        return result;
      },
    );

    if (installFeed) this.installFeed = installFeed;

    return result;
  }
  override quitAndInstall() {
    if (!this.installFeed) {
      super.quitAndInstall();

      return;
    }

    this.installFeed.install(
      () => super.quitAndInstall(),
      (cause: unknown) => {
        this.emit("error", cause instanceof Error ? cause : new Error("Could not prepare the app update"));
      },
    );
  }
}

export function checkAppUpdateInstall(updater: AppUpdater) {
  if (updater instanceof StagedNsisUpdater) updater.checkInstall();
}

/** Only main can reveal the verified download; the renderer never supplies a path. */
export function appUpdateInstaller(updater: AppUpdater) {
  return updater instanceof StagedNsisUpdater ? updater.manualInstaller : null;
}

class StagedAppImageUpdater extends AppImageUpdater {
  private readonly downloads = new StagedDownloads();
  constructor(directory?: string) {
    super();

    if (directory) this.downloadedUpdateHelper = new DownloadedUpdateHelper(directory);
  }
  protected override executeDownload(task: DownloadExecutorTask) {
    task = cancellable(task);

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
export function createAppUpdater(recovery = false): AppUpdater {
  // A retired request may still write or clear its cache. Never reuse that directory in a recovery.
  const directory = recovery ? join(app.getPath("userData"), "updates", randomUUID()) : undefined;

  if (process.platform === "darwin") return new StagedMacUpdater(directory);

  if (process.platform === "win32") return new StagedNsisUpdater(directory);

  return new StagedAppImageUpdater(directory);
}
