import type { AppUpdater } from "electron-updater";
import type { DesktopUpdateStatus, DesktopReleaseNote } from "@canopy/ui/desktop";
import type { DesktopChannel } from "./identity.ts";
import { channelFeed, channelRank, isDesktopChannel } from "./update-releases.ts";

type Updater = Pick<
  AppUpdater,
  "channel" | "allowPrerelease" | "allowDowngrade" | "autoDownload" | "autoInstallOnAppQuit" | "on" | "checkForUpdates"
>;

interface Options {
  version: string;
  buildChannel: DesktopChannel;
  channel: DesktopChannel;
  save(channel: DesktopChannel): void;
  confirmDowngrade(channel: DesktopChannel): Promise<boolean>;
  prepare(
    channel: DesktopChannel,
    allowDowngrade: boolean,
  ): Promise<boolean | { available: boolean; releases: DesktopReleaseNote[]; publishing: string | undefined }>;
  changed(): void;
  downloaded(): void;
}

/** Owns a serialized check/download and a single, non-persistent downgrade grant. */
export class UpdateController {
  private state: DesktopUpdateStatus;
  private enabled = false;
  private running = false;
  constructor(
    private readonly updater: Updater,
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
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = false;
    this.configure(false);
    updater.on("error", () => {
      if (this.running) this.publish({ phase: "error", message: "Update failed — check again to retry" });
    });
    updater.on("download-progress", (progress) => {
      if (this.running)
        this.publish({
          phase: "downloading",
          message: "Downloading update…",
          progress: Math.max(0, Math.min(100, progress.percent)),
        });
    });
    updater.on("update-available", (info) => {
      if (this.running)
        this.publish({
          phase: "downloading",
          message: "Downloading update…",
          progress: 0,
          updateVersion: info.version,
        });
    });
    updater.on("update-downloaded", (info) => {
      if (!this.running) return;
      this.publish({
        phase: "downloaded",
        message: "An update is ready to install",
        updateVersion: info.version,
        progress: 100,
      });
      options.downloaded();
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
    this.publish({ phase: reason ? "disabled" : "idle", message: reason ?? "Ready to check for updates" });
  }
  async setChannel(raw: string) {
    if (!isDesktopChannel(raw)) throw new Error("Invalid update channel");

    if (this.running || this.state.changingChannel) throw new Error("Wait for the current update operation to finish");

    if (raw === this.state.channel) return this.status();
    const downgrade = channelRank[raw] < channelRank[this.state.channel];
    this.publish({ changingChannel: true });

    try {
      if (!downgrade || (await this.options.confirmDowngrade(raw))) {
        this.options.save(raw);
        this.publish({
          channel: raw,
          phase: this.enabled ? "idle" : "disabled",
          updateVersion: undefined,
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
    return this.state.changingChannel ? Promise.resolve(this.status()) : this.runCheck(false);
  }
  checkRemote() {
    if (this.running || this.state.changingChannel)
      throw new Error("Wait for the current app update operation to finish, then retry.");

    return this.runCheck(false);
  }
  private async runCheck(allowDowngrade: boolean) {
    if (!this.enabled || this.running || this.state.phase === "downloaded") return this.status();
    this.running = true;
    this.publish({
      phase: "checking",
      message: "Checking for updates…",
      progress: undefined,
      updateVersion: undefined,
      releases: undefined,
      publishing: undefined,
    });
    this.configure(allowDowngrade);

    try {
      const prepared = await this.options.prepare(this.state.channel, allowDowngrade);
      const available = prepared === true || (prepared !== false && prepared.available);

      if (prepared !== true && prepared !== false)
        this.publish({ releases: prepared.releases, publishing: prepared.publishing });

      if (!available) {
        this.publish({
          phase: "idle",
          message: this.state.publishing ?? "Up to date — no update available for this channel",
        });

        return this.status();
      }

      const result = await this.updater.checkForUpdates();
      await result?.downloadPromise;

      if (this.state.phase === "checking")
        this.publish({ phase: "idle", message: "Up to date — check again any time" });
    } catch {
      this.publish({ phase: "error", message: "Update failed — check again to retry", progress: undefined });
    } finally {
      this.updater.allowDowngrade = false;
      this.running = false;
      this.options.changed();
    }

    return this.status();
  }
}
