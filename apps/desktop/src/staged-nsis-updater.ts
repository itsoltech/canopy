import { copyFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { CancellationError } from "builder-util-runtime";
import { NsisUpdater } from "electron-updater/out/NsisUpdater.js";
import type { AppAdapter } from "electron-updater/out/AppAdapter.js";
import type { DownloadExecutorTask } from "electron-updater/out/AppUpdater.js";
import { DownloadedUpdateHelper } from "electron-updater/out/DownloadedUpdateHelper.js";
import { cancellable, StagedDownloads } from "./staged-downloads.ts";
import { updateErrorCode } from "./update-diagnostics.ts";
import { checkWindowsUpdateInstall } from "./update-install.ts";

class NsisReplacement extends DownloadedUpdateHelper {
  private readonly priorInstaller: string | null;

  constructor(
    previous: DownloadedUpdateHelper,
    private readonly installedCache: string,
  ) {
    const first = join(installedCache, "replacement");
    super(previous.cacheDir === first ? join(installedCache, "replacement-2") : first);
    this.priorInstaller = previous.file;
  }

  async oldInstaller(installed: string) {
    // 6.8.11 reads the old blockmap from cacheDir and writes the new one in pending.
    const cachedMap = join(this.cacheDir, "current.blockmap");

    const priorMap = this.priorInstaller && join(dirname(this.priorInstaller), "current.blockmap");

    if (this.priorInstaller && priorMap && existsSync(priorMap)) {
      await copyFile(priorMap, cachedMap);

      return relative(this.cacheDir, this.priorInstaller);
    }

    // Let the provider fetch the installed version's map alongside installer.exe.
    await rm(cachedMap, { force: true });

    return relative(this.cacheDir, join(this.installedCache, installed));
  }
}

export class StagedNsisUpdater extends NsisUpdater {
  private readonly downloads = new StagedDownloads((previous, root) => new NsisReplacement(previous, root));
  constructor(directory?: string, adapter?: AppAdapter) {
    super(null, adapter);

    if (directory) this.downloadedUpdateHelper = new DownloadedUpdateHelper(directory);
  }
  get manualInstaller() {
    return this.installerPath;
  }
  checkInstall() {
    checkWindowsUpdateInstall(
      resolve(process.execPath, ".."),
      this.downloadedUpdateHelper?.downloadedFileInfo?.isAdminRightsRequired ?? false,
    );
  }
  protected override async executeDownload(task: DownloadExecutorTask) {
    task = cancellable(task);
    const previous = this.downloadedUpdateHelper;

    if (previous?.file && !(previous instanceof NsisReplacement)) {
      // The primary slot promoted the staged map before NSIS could update installer.exe.
      // A cold start during a replacement needs the installed version's map.
      try {
        await rm(join(previous.cacheDir, "current.blockmap"), { force: true });
      } catch (cause) {
        this._logger.warn(
          `Could not clear the staged NSIS blockmap: ${updateErrorCode(cause instanceof Error ? cause : undefined)}`,
        );
      }
    }

    return this.downloads.run(
      previous,
      (helper) => {
        this.downloadedUpdateHelper = helper;
      },
      async () => {
        const result = await super.executeDownload(task);

        // BaseUpdater supplies its own done callback, including on a cache hit.
        if (task.downloadUpdateOptions.cancellationToken.cancelled) throw new CancellationError();

        return result;
      },
    );
  }

  protected override async differentialDownloadInstaller(
    ...[file, options, destination, provider, installed]: Parameters<NsisUpdater["differentialDownloadInstaller"]>
  ) {
    const helper = this.downloadedUpdateHelper;
    let source = installed;

    if (helper instanceof NsisReplacement) {
      try {
        source = await helper.oldInstaller(installed);
      } catch (cause) {
        this._logger.error(
          `Cannot download differentially, fallback to full download: ${updateErrorCode(cause instanceof Error ? cause : undefined)}`,
        );

        // An unreadable delta base must still allow NSIS's verified full download.
        return true;
      }
    }

    return super.differentialDownloadInstaller(file, options, destination, provider, source);
  }
}
