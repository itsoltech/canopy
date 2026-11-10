import { AppImageUpdater, MacUpdater, NsisUpdater, type AppUpdater } from "electron-updater";
import type { DownloadExecutorTask } from "electron-updater/out/AppUpdater.js";
import type { UpdateDownloadedEvent } from "electron-updater";
import { StagedDownloads } from "./staged-downloads.ts";
import { DownloadedUpdateHelper } from "electron-updater/out/DownloadedUpdateHelper.js";
import { CancellationError } from "builder-util-runtime";
import { app } from "electron";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { UpdateOperation } from "./update-operation.ts";

// Squirrel has one native feed for every MacUpdater instance. Serialize commits and
// replay the installable feed last, including after a retired finalizer returns late.
let macFinalizing = Promise.resolve();

function commitMacFeed(run: () => Promise<void>) {
  const next = macFinalizing.then(run, run);
  macFinalizing = next.catch(() => {});

  return next;
}

/** Cancelled attempts must not commit files or replace the native macOS feed when they settle late. */
function cancellable(task: DownloadExecutorTask): DownloadExecutorTask {
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

class StagedMacUpdater extends MacUpdater {
  private readonly downloads = new StagedDownloads();
  private installFeed: (() => Promise<void>) | undefined;
  constructor(directory?: string) {
    super();

    if (directory) this.downloadedUpdateHelper = new DownloadedUpdateHelper(directory);
  }
  protected override async executeDownload(task: DownloadExecutorTask) {
    task = cancellable(task);
    let installFeed: (() => Promise<void>) | undefined;

    const files = await this.downloads.run(
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

        if (downloaded) {
          const event = downloaded;

          const commit = async () => {
            await task.done?.(event);
          };

          await commitMacFeed(commit);
          installFeed = () => commitMacFeed(commit);
        }

        return files;
      },
    );

    if (installFeed) this.installFeed = installFeed;

    return files;
  }
  override quitAndInstall() {
    const operation = new UpdateOperation();
    void operation
      .wait("check", async () => {
        if (!this.installFeed) throw new Error("No staged app update");
        await this.installFeed();
      })
      .then(() => super.quitAndInstall())
      .catch((cause: unknown) => {
        this.emit("error", cause instanceof Error ? cause : new Error("Could not prepare the app update"));
      });
  }
}

class StagedNsisUpdater extends NsisUpdater {
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
