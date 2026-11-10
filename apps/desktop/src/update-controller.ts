import type { AppUpdater } from "electron-updater";
import type { AppUpdaterEvents } from "electron-updater/out/AppUpdater.js";
import type { DesktopUpdateStatus, DesktopReleaseNote } from "@canopy/ui/desktop";
import type { DesktopChannel } from "./identity.ts";
import { channelFeed, channelRank, isDesktopChannel } from "./update-releases.ts";
import { gt } from "semver";
import { UpdateOperation, UpdateResumed, updateTimeouts } from "./update-operation.ts";
import type { CheckClock } from "@canopy/domain/update-checks";

export type Updater = Pick<
  AppUpdater,
  | "channel"
  | "allowPrerelease"
  | "allowDowngrade"
  | "autoDownload"
  | "autoInstallOnAppQuit"
  | "checkForUpdates"
  | "downloadUpdate"
> & { on<K extends keyof AppUpdaterEvents>(event: K, listener: AppUpdaterEvents[K]): void };

interface Options {
  version: string;
  buildChannel: DesktopChannel;
  channel: DesktopChannel;
  recover(): Updater;
  clock?: CheckClock;
  timeouts?: typeof updateTimeouts;
  save(channel: DesktopChannel): void;
  confirmDowngrade(channel: DesktopChannel): Promise<boolean>;
  prepare(
    channel: DesktopChannel,
    allowDowngrade: boolean,
    signal: AbortSignal,
  ): Promise<boolean | { available: boolean; releases: DesktopReleaseNote[]; publishing: string | undefined }>;
  changed(): void;
  checking?(): void;
  downloaded(): void;
}

/** Owns a serialized check/download and a single, non-persistent downgrade grant. */
export class UpdateController {
  private state: DesktopUpdateStatus;
  private enabled = false;
  private running = false;
  private automaticEnabled = true;
  private runningAutomatic = false;
  private operation?: Promise<DesktopUpdateStatus>;
  private channelOperation: Promise<DesktopUpdateStatus> | undefined;
  private attempt: UpdateOperation | undefined;
  private interrupted = false;
  private installing = false;
  private staged: DesktopUpdateStatus | undefined;
  private downloadedVersion: string | undefined;
  private cancelDownload: (() => void) | undefined;
  constructor(
    private updater: Updater,
    private readonly options: Options,
  ) {
    this.state = {
      version: options.version,
      buildChannel: options.buildChannel,
      channel: options.channel,
      phase: "disabled",
      message: "Updates are available in installed builds",
      changingChannel: false,
    };
    this.listen(updater);
  }
  private listen(updater: Updater) {
    const active = () => this.running && this.updater === updater && this.attempt?.active;
    // Check metadata before touching pending: the feed may still point at the staged version.
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    this.configure(false);
    updater.on("error", () => {
      // The promise owns failures; a late error from a retired updater cannot change the new attempt.
    });
    updater.on("download-progress", (progress) => {
      if (active()) {
        this.attempt?.progress(progress.transferred);
        this.publish({
          phase: "downloading",
          message: "Downloading update…",
          progress: Math.max(0, Math.min(100, progress.percent)),
        });
      }
    });
    updater.on("update-available", (info) => {
      if (
        active() &&
        (!this.state.stagedVersion || gt(info.version, this.state.stagedVersion) || updater.allowDowngrade)
      )
        this.publish({
          phase: "downloading",
          message: "Downloading update…",
          progress: 0,
          updateVersion: info.version,
        });
    });
    updater.on("update-downloaded", (info) => {
      if (!active()) return;
      // executeDownload can still fail after this event. Commit only after its promise resolves.
      this.downloadedVersion = info.version;
    });
  }
  status(): DesktopUpdateStatus {
    return { ...this.state };
  }
  private publish(patch: Partial<DesktopUpdateStatus>) {
    this.state = { ...this.state, ...patch };
    this.options.changed();
  }
  private configure(downgrade: boolean) {
    this.updater.channel = channelFeed(this.state.channel);
    this.updater.allowPrerelease = this.state.channel !== "stable";
    // electron-updater's channel setter itself enables downgrade. Always overwrite it.
    this.updater.allowDowngrade = downgrade;
  }
  enable(reason?: string) {
    this.enabled = !reason;
    this.publish({ phase: reason ? "disabled" : "idle", message: reason ?? "Not checked yet" });
  }
  setChannel(raw: string): Promise<DesktopUpdateStatus> {
    if (!isDesktopChannel(raw)) return Promise.reject(new Error("Invalid update channel"));
    const previous = this.channelOperation;

    const next = (async () => {
      await previous?.catch(() => {});
      await this.operation;

      return this.switchChannel(raw);
    })();

    this.channelOperation = next;
    void next
      .finally(() => {
        if (this.channelOperation === next) this.channelOperation = undefined;
      })
      .catch(() => {});

    return next;
  }
  private async switchChannel(raw: DesktopChannel) {
    if (this.installing) return this.status();

    if (raw === this.state.channel) return this.status();
    const downgrade = channelRank[raw] < channelRank[this.state.channel];
    this.publish({ changingChannel: true });

    try {
      if (!downgrade || (await this.options.confirmDowngrade(raw))) {
        this.options.save(raw);
        this.staged = undefined;
        this.publish({
          channel: raw,
          phase: this.enabled ? "idle" : "disabled",
          updateVersion: undefined,
          stagedVersion: undefined,
          error: undefined,
          progress: undefined,
          releases: undefined,
          publishing: undefined,
          message: this.enabled ? "Update channel changed" : this.state.message,
        });
        this.configure(false);
        // The grant exists only for this switch's check/download, never the timer or next launch.
        await this.runCheck(downgrade);
      }
    } finally {
      this.publish({ changingChannel: false });
    }

    return this.status();
  }
  check() {
    return this.channelOperation ?? this.runCheck(false);
  }
  setAutomaticUpdates(enabled: boolean): void {
    this.automaticEnabled = enabled;

    if (!enabled && this.runningAutomatic) {
      this.updater.autoDownload = false;
      this.cancelDownload?.();
    }
  }
  checkAutomatically() {
    return this.automaticEnabled && !this.channelOperation
      ? this.runCheck(false, true)
      : Promise.resolve(this.status());
  }
  checkRemote() {
    return this.check();
  }
  resume() {
    this.attempt?.recover();

    if (!this.running && this.interrupted && this.automaticEnabled) return this.checkAutomatically();

    return this.running && this.operation ? this.operation : Promise.resolve(this.status());
  }
  async prepareInstall() {
    if (!this.state.stagedVersion || this.state.changingChannel || this.installing) return false;
    this.installing = true;
    await this.operation;

    if (this.state.phase === "downloaded" && this.state.stagedVersion) return true;
    this.installing = false;

    return false;
  }
  private runCheck(allowDowngrade: boolean, automatic = false): Promise<DesktopUpdateStatus> {
    if (this.running && this.operation) return this.operation;

    if (!this.enabled || this.installing) return Promise.resolve(this.status());
    const operation = Promise.withResolvers<DesktopUpdateStatus>();
    this.operation = operation.promise;
    void this.performCheck(allowDowngrade, automatic).then(operation.resolve, operation.reject);

    return this.operation;
  }
  private settle(message = "Up to date", error?: string) {
    this.publish(
      this.staged
        ? {
            phase: "downloaded",
            message: this.staged.message,
            updateVersion: this.staged.updateVersion,
            stagedVersion: this.staged.stagedVersion,
            progress: 100,
            releases: this.staged.releases,
            error,
          }
        : { phase: error ? "error" : "idle", message: error ?? message, error, progress: undefined },
    );
  }
  private async performCheck(allowDowngrade: boolean, automatic: boolean) {
    this.running = true;
    this.interrupted = false;
    this.runningAutomatic = automatic;

    try {
      for (;;) {
        const attempt = new UpdateOperation(this.options.clock, this.options.timeouts);
        this.attempt = attempt;

        try {
          await this.performAttempt(allowDowngrade, automatic, attempt);
          break;
        } catch (error) {
          if (attempt.signal.aborted) {
            this.interrupted = true;
            this.updater.allowDowngrade = false;
            this.updater = this.options.recover();
            this.listen(this.updater);
          }

          if (error instanceof UpdateResumed) {
            this.interrupted = false;

            if (!automatic || this.automaticEnabled) continue;
            this.settle("Automatic checks and downloads are off");
            break;
          }

          this.settle(
            "",
            attempt.signal.aborted && error instanceof Error ? error.message : "Update failed. Check again to retry.",
          );
          break;
        } finally {
          attempt.close();

          if (this.cancelDownload) attempt.signal.removeEventListener("abort", this.cancelDownload);
          this.cancelDownload = undefined;
        }
      }
    } catch {
      this.settle("", "Update failed. Check again to retry.");
    } finally {
      this.updater.allowDowngrade = false;
      this.running = false;
      this.runningAutomatic = false;
      this.cancelDownload = undefined;
      this.attempt = undefined;
      this.options.changed();
    }

    return this.status();
  }
  private async performAttempt(allowDowngrade: boolean, automatic: boolean, attempt: UpdateOperation) {
    const updater = this.updater;
    this.downloadedVersion = undefined;
    this.publish({
      phase: "checking",
      message: "Checking for updates…",
      progress: undefined,
      updateVersion: this.staged?.updateVersion,
      error: undefined,
      releases: undefined,
      publishing: undefined,
    });
    this.configure(allowDowngrade);

    this.options.checking?.();

    const prepared = await attempt.wait("prepare", () =>
      this.options.prepare(this.state.channel, allowDowngrade, attempt.signal),
    );

    if (automatic && !this.automaticEnabled) {
      this.settle("Automatic checks and downloads are off");

      return;
    }

    const available = prepared === true || (prepared !== false && prepared.available);

    if (prepared !== true && prepared !== false)
      this.publish({ releases: prepared.releases, publishing: prepared.publishing });

    if (!available) {
      this.settle(this.state.publishing);

      return;
    }

    const result = await attempt.wait("check", () =>
      updater.checkForUpdates().then((result) => {
        if (attempt.signal.aborted) result?.cancellationToken?.cancel();

        return result;
      }),
    );

    this.cancelDownload = () => result?.cancellationToken?.cancel();
    attempt.signal.addEventListener("abort", this.cancelDownload, { once: true });

    if (automatic && !this.automaticEnabled) this.cancelDownload();

    if (
      result?.isUpdateAvailable &&
      (!automatic || this.automaticEnabled) &&
      (!this.staged?.updateVersion || allowDowngrade || gt(result.updateInfo.version, this.staged.updateVersion))
    ) {
      await attempt.wait("download", () => updater.downloadUpdate(result.cancellationToken));

      if (this.downloadedVersion) {
        this.publish({
          phase: "downloaded",
          message: "An update is ready to install",
          updateVersion: this.downloadedVersion,
          stagedVersion: this.downloadedVersion,
          error: undefined,
          progress: 100,
        });
        this.staged = this.status();
        this.options.downloaded();
      }
    }

    if (["checking", "downloading"].includes(this.state.phase)) this.settle();
  }
}
