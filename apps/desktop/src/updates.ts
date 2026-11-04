import { app, dialog, Notification, type MenuItemConstructorOptions } from "electron";
import { autoUpdater } from "electron-updater";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { desktopIdentity, type DesktopChannel } from "./identity.ts";
import { newestRelease, type DesktopRelease } from "./update-releases.ts";
import { UpdateController } from "./update-controller.ts";
import { UpdateSettings } from "./update-settings.ts";

export class DesktopUpdates {
  private controller?: UpdateController;
  private timer?: ReturnType<typeof setInterval>;
  private readonly identity = desktopIdentity();

  constructor(
    private readonly changed: () => void,
    private readonly restart: () => void,
  ) {}

  private get control() {
    if (!this.controller) {
      const settings = new UpdateSettings(app.getPath("userData"));
      autoUpdater.logger = null;
      this.controller = new UpdateController(autoUpdater, {
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
    return this.control.status();
  }
  setChannel(channel: unknown) {
    return this.control.setChannel(channel);
  }
  check() {
    return this.control.check();
  }
  restartIfReady() {
    if (this.status().phase === "downloaded" && !this.status().changingChannel) this.restart();
  }

  item(): MenuItemConstructorOptions {
    const state = this.status();

    return {
      label: state.phase === "downloaded" ? "Restart to update" : state.message,
      enabled: !["disabled", "checking", "downloading"].includes(state.phase) && !state.changingChannel,
      click: () => (state.phase === "downloaded" ? this.restartIfReady() : void this.check()),
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
    await this.check();
    this.timer = setInterval(() => void this.check(), 6 * 60 * 60 * 1000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
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

    autoUpdater.once("error", failed);

    try {
      autoUpdater.quitAndInstall(false, true);
    } catch {
      autoUpdater.removeListener("error", failed);
      failed();
    }
  }

  private async prepare(channel: DesktopChannel, allowDowngrade: boolean) {
    const suffix =
      process.platform === "darwin"
        ? "-mac"
        : process.platform === "linux"
          ? `-linux${process.arch === "arm64" ? "-arm64" : ""}`
          : "";

    const feed = channel === "stable" ? "latest" : channel;
    const feedFile = `${feed}${suffix}.yml`;
    const releases: DesktopRelease[] = [];

    for (let page = 1; page <= 10; page++) {
      const response = await fetch(`https://api.github.com/repos/itsoltech/canopy/releases?per_page=100&page=${page}`, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": `${this.identity.executableName}/${app.getVersion()}`,
        },
        signal: AbortSignal.timeout(20_000),
      });

      if (!response.ok) throw new Error("Release feed unavailable");
      const batch = (await response.json()) as DesktopRelease[];
      releases.push(...batch);

      if (batch.length < 100) break;
    }

    const release = newestRelease(releases, app.getVersion(), channel, feedFile, allowDowngrade);

    if (!release) return false;
    autoUpdater.setFeedURL({
      provider: "generic",
      url: `https://github.com/itsoltech/canopy/releases/download/${encodeURIComponent(release.tag_name)}/`,
      channel: feed,
      useMultipleRangeRequest: false,
    });

    return true;
  }
}
