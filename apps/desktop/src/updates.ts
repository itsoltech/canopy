import { app, dialog, Notification, type MenuItemConstructorOptions } from "electron";
import { createAppUpdater } from "./app-updater.ts";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { desktopIdentity, type DesktopChannel } from "./identity.ts";
import { DesktopUpdateFeed } from "./update-feed.ts";
import { UpdateController } from "./update-controller.ts";
import { UpdateSettings } from "./update-settings.ts";
import { UpdateCheckSettings } from "./update-check-settings.ts";
import { UpdateCheckTimer, nextUpdateCheck } from "@canopy/domain/update-checks";

export class DesktopUpdates {
  private controller?: UpdateController;
  private readonly timer = new UpdateCheckTimer();
  private checkSettings?: UpdateCheckSettings;
  private enabled = false;
  private get schedule() {
    return (this.checkSettings ??= new UpdateCheckSettings(app.getPath("userData")));
  }
  private readonly identity = desktopIdentity();
  private readonly feed = new DesktopUpdateFeed();
  private readonly updater = createAppUpdater();

  constructor(
    private readonly changed: () => void,
    private readonly restart: () => void,
  ) {}

  private get control() {
    if (!this.controller) {
      const settings = new UpdateSettings(app.getPath("userData"));
      this.updater.logger = null;
      this.controller = new UpdateController(this.updater, {
        version: app.getVersion(),
        buildChannel: this.identity.channel,
        channel: settings.read(this.identity.channel),
        save: (channel) => settings.write(channel),
        confirmDowngrade: async (channel) =>
          (
            await dialog.showMessageBox({
              type: "warning",
              title: "Switch to a more stable channel?",
              message: `Switch to ${channel === "stable" ? "Stable" : "Beta"}?`,
              detail:
                "This switch allows installing an older version. Data written by newer versions may not be readable, and Canopy may stop working. Back up your data before continuing. Downgrades are allowed only for this switch’s update attempt.",
              buttons: ["Cancel", "Switch channel"],
              defaultId: 0,
              cancelId: 0,
              noLink: true,
            })
          ).response === 1,
        prepare: (channel, downgrade) => this.prepare(channel, downgrade),
        changed: this.changed,
        checking: () => this.schedule.save(this.schedule.minutes, Date.now()),
        downloaded: () => {
          if (!Notification.isSupported()) return;

          const notice = new Notification({
            title: "Canopy",
            body: "An update is ready. Choose Restart to update in App updates or the application menu.",
          });

          notice.on("click", () => this.restartIfReady());
          notice.show();
        },
      });
    }

    return this.controller;
  }
  status() {
    return {
      ...this.control.status(),
      checkIntervalMinutes: this.schedule.minutes,
      lastCheckedAt: this.schedule.lastChecked,
      ...(this.enabled &&
        this.schedule.minutes !== 0 && {
          nextCheckAt: nextUpdateCheck(this.schedule.lastChecked, this.schedule.minutes, Date.now()),
        }),
    };
  }
  setCheckInterval(minutes: number) {
    this.schedule.save(minutes);
    this.control.setAutomaticUpdates(minutes !== 0);
    this.reschedule();
    this.changed();

    return this.status();
  }
  private reschedule() {
    this.timer.stop();

    if (this.enabled)
      this.timer.start(this.schedule.minutes, this.schedule.lastChecked, async () => {
        await this.control.checkAutomatically();
      });
  }
  async setChannel(channel: string) {
    await this.control.setChannel(channel);
    this.reschedule();
    this.changed();

    return this.status();
  }
  async check() {
    await this.control.check();
    this.reschedule();
    this.changed();

    return this.status();
  }
  async checkRemote() {
    await this.control.checkRemote();
    this.reschedule();
    this.changed();

    return this.status();
  }
  async restartIfReady() {
    if (await this.prepareRestart()) this.restartPrepared();
  }
  async prepareRestart() {
    return (await this.control.prepareInstall()) ? this.status() : undefined;
  }
  restartPrepared() {
    if (this.status().phase === "downloaded" && !this.status().changingChannel) this.restart();
  }

  item(): MenuItemConstructorOptions {
    const state = this.status();

    return {
      label: state.stagedVersion ? "Restart to update" : state.message,
      enabled:
        (!!state.stagedVersion || !["disabled", "checking", "downloading"].includes(state.phase)) &&
        !state.changingChannel,
      click: () => (state.stagedVersion ? void this.restartIfReady() : void this.check()),
    };
  }

  async start() {
    if (!app.isPackaged) {
      this.control.enable("Updates are available in installed builds");

      return;
    }

    if (process.platform === "darwin") {
      // Only a Developer ID build can take updates: Squirrel accepts a new bundle only if it satisfies the running
      // app's designated requirement. Read the signer, not the bundle seal: a seal broken by older builds (their
      // worker replaced itself inside the bundle) must not block the update that replaces the whole bundle.
      const bundle = resolve(process.execPath, "../../..");

      // codesign --display reports to stderr.
      const { stderr: signature = "" } = spawnSync("codesign", ["--display", "--verbose=2", bundle], {
        encoding: "utf8",
      });

      if (
        !/^Authority=Developer ID Application: /m.test(signature) ||
        !/^TeamIdentifier=(?!not set)\w+/m.test(signature)
      ) {
        this.control.enable("Updates need a signed build");

        return;
      }
    } else if (process.platform === "linux" && !process.env["APPIMAGE"]) {
      this.control.enable("Update this installation with your package manager");

      return;
    }

    this.control.enable();
    this.enabled = true;
    this.control.setAutomaticUpdates(this.schedule.minutes !== 0);
    this.reschedule();
  }

  stop() {
    this.enabled = false;
    this.timer.stop();
  }
  install() {
    if (this.status().phase !== "downloaded") return;

    // Squirrel validates and stages the macOS ZIP after this call. Services have
    // already stopped; recover to the current version if that final step fails.
    const failed = () => {
      dialog.showErrorBox(
        "Update could not be installed",
        `${this.identity.productName} will restart using the current version. Retry the update from the application menu.`,
      );
      app.relaunch();
      app.quit();
    };

    this.updater.once("error", failed);

    try {
      this.updater.quitAndInstall(false, true);
    } catch {
      this.updater.removeListener("error", failed);
      failed();
    }
  }

  private async prepare(channel: DesktopChannel, allowDowngrade: boolean) {
    const result = await this.feed.resolve(channel, allowDowngrade);
    const { release, feed } = result;

    if (!release) return { available: false, releases: result.releases, publishing: result.publishing };
    this.updater.setFeedURL({
      provider: "generic",
      url: `https://github.com/itsoltech/canopy/releases/download/${encodeURIComponent(release.tag_name)}/`,
      channel: feed,
      useMultipleRangeRequest: false,
    });

    return { available: true, releases: result.releases, publishing: result.publishing };
  }
}
