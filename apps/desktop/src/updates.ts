import { app, dialog, Notification, type MenuItemConstructorOptions } from "electron";
import { autoUpdater } from "electron-updater";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { desktopIdentity } from "./identity.ts";
import { newestRelease, type DesktopRelease } from "./update-releases.ts";

export class DesktopUpdates {
  private text = "Check for updates…";
  private available = false;
  private enabled = false;
  private checking = false;
  private timer?: ReturnType<typeof setInterval>;
  private readonly identity = desktopIdentity();

  constructor(private readonly changed: () => void, private readonly restart: () => void) {}

  item(): MenuItemConstructorOptions {
    return { label: this.available ? "Restart to update" : this.text, enabled: this.enabled && (!this.checking || this.available), click: () => this.available ? this.restart() : void this.check() };
  }

  async start() {
    if (!app.isPackaged) { this.text = "Updates are available in installed builds"; this.changed(); return; }
    if (process.platform === "darwin") {
      try {
        const bundle = resolve(process.execPath, "../../..");
        execFileSync("codesign", ["--verify", "--deep", "--strict", bundle], { stdio: "pipe" });
        // Use a requirement to validate Developer ID
        // instead of trusting a build-time flag or an ad-hoc signature.
        execFileSync("codesign", ["--verify", "--test-requirement", "anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists", bundle], { stdio: "pipe" });
      } catch { this.text = "Updates need a signed build"; this.changed(); return; }
    } else if (process.platform === "linux" && !process.env["APPIMAGE"]) {
      this.text = "Update this installation with your package manager"; this.changed(); return;
    }
    this.enabled = true;
    autoUpdater.logger = null;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = this.identity.channel !== "stable";
    autoUpdater.channel = this.identity.feed;
    autoUpdater.allowDowngrade = false; // Setting channel enables downgrades; always reset afterwards.
    autoUpdater.on("error", () => { this.text = "Update failed — click to retry"; this.changed(); });
    autoUpdater.on("download-progress", () => { this.text = "Downloading update…"; this.changed(); });
    autoUpdater.on("update-downloaded", () => {
      this.available = true;
      this.changed();
      if (Notification.isSupported()) {
        const notice = new Notification({ title: this.identity.productName, body: "An update is ready. Choose Restart to update in the application menu." });
        notice.on("click", this.restart);
        notice.show();
      }
    });
    await this.check();
    this.timer = setInterval(() => void this.check(), 6 * 60 * 60 * 1000);
    this.timer.unref();
  }

  stop() { if (this.timer) clearInterval(this.timer); }
  install() {
    if (!this.available) return;
    // Squirrel validates and stages the macOS ZIP after this call. Services have
    // already stopped; recover to the current version if that final step fails.
    const failed = () => {
      dialog.showErrorBox("Update could not be installed", `${this.identity.productName} will restart using the current version. Retry the update from the application menu.`);
      app.relaunch();
      app.quit();
    };
    autoUpdater.once("error", failed);
    try { autoUpdater.quitAndInstall(false, true); }
    catch { autoUpdater.removeListener("error", failed); failed(); }
  }

  private async check() {
    if (!this.enabled || this.checking || this.available) return;
    this.checking = true;
    this.text = "Checking for updates…";
    this.changed();
    try {
      const suffix = process.platform === "darwin" ? "-mac" : process.platform === "linux" ? `-linux${process.arch === "arm64" ? "-arm64" : ""}` : "";
      const feedFile = `${this.identity.feed}${suffix}.yml`;
      const releases: DesktopRelease[] = [];
      for (let page = 1; page <= 10; page++) {
        const response = await fetch(`https://api.github.com/repos/itsoltech/canopy/releases?per_page=100&page=${page}`, {
          headers: { Accept: "application/vnd.github+json", "User-Agent": `${this.identity.executableName}/${app.getVersion()}` },
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) throw new Error("Release feed unavailable");
        const batch = await response.json() as DesktopRelease[];
        releases.push(...batch);
        if (batch.length < 100) break;
      }
      const release = newestRelease(releases, app.getVersion(), this.identity.channel, feedFile);
      if (!release) { this.text = "Up to date — check again"; return; }
      autoUpdater.setFeedURL({ provider: "generic", url: `https://github.com/itsoltech/canopy/releases/download/${encodeURIComponent(release.tag_name)}/`, channel: this.identity.feed, useMultipleRangeRequest: false });
      const result = await autoUpdater.checkForUpdates();
      await result?.downloadPromise;
    } catch { this.text = "Update failed — click to retry"; }
    finally { this.checking = false; this.changed(); }
  }
}
