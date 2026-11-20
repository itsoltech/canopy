import { BrowserWindow, ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import { Schema } from "effect";
import type { DesktopStatus } from "@canopy/ui/desktop";
import type { QuitGuard } from "./quit-guard.ts";
import { windowColors } from "./window-appearance.ts";
import { windowContents } from "./window-message.ts";

const parsePath = Schema.decodeUnknownSync(
  Schema.String.check(
    Schema.isMaxLength(128 * 1024),
    Schema.isPattern(/^\/threads\/[a-z\d~-]{1,100}\/preview(?:#.*)?$/i),
  ),
);

export class PreviewWindows {
  readonly #windows = new Map<string, BrowserWindow>();

  constructor(
    private readonly icon: string,
    private readonly quitGuard: QuitGuard,
    private readonly openToolSettings: () => void,
  ) {}

  register(
    authorize: (event: IpcMainInvokeEvent) => void,
    mainContents: () => WebContents | undefined,
    currentStatus: () => DesktopStatus,
  ) {
    ipcMain.handle("canopy:open-preview-window", async (event, path: string) => {
      authorize(event);
      const status = currentStatus();

      if (event.sender !== mainContents() || !status.webUrl || status.phase !== "running" || status.needsPairing)
        throw new Error("Preview window is unavailable");

      await this.#open(path, event.sender, status.webUrl);
    });
  }

  statusChanged(previous: DesktopStatus, next: DesktopStatus) {
    if (
      next.phase !== "running" ||
      next.needsPairing ||
      next.mode !== previous.mode ||
      next.webUrl !== previous.webUrl ||
      next.gatewayUrl !== previous.gatewayUrl
    )
      this.closeAll();
  }

  contents(): (WebContents | undefined)[] {
    return Array.from(this.#windows.values(), windowContents);
  }

  closeAll() {
    for (const window of this.#windows.values()) window.destroy();
    this.#windows.clear();
  }

  async #open(path: string, sender: WebContents, origin: string) {
    const url = new URL(parsePath(path), origin);
    const source = new URL(sender.getURL());

    if (source.origin !== url.origin || `${source.pathname}/preview` !== url.pathname)
      throw new Error("Open a preview from its thread");

    const key = url.pathname;
    const existing = this.#windows.get(key);

    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();

      return;
    }

    // A top-level native frame can move independently, including between displays. It has no preload bridge.
    const window = new BrowserWindow({
      width: 1000,
      height: 720,
      minWidth: 360,
      minHeight: 360,
      title: "Preview",
      icon: this.icon,
      show: false,
      backgroundColor: windowColors().canvas,
      webPreferences: {
        session: sender.session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        webviewTag: false,
      },
    });

    this.#windows.set(key, window);
    this.quitGuard.attach(window);

    if (process.platform !== "darwin") window.setMenu(null);
    window.once("closed", () => this.#windows.delete(key));

    const contents = window.webContents;
    // Pin the document to this preview route, and open tool settings through the main window.
    const pageUrl = new URL(url.pathname, url.origin).href;
    const settingsUrl = new URL("/settings/agent-tools", url.origin).href;
    const allowDocument = (destination: string) => destination.split("#")[0] === pageUrl;
    contents.on("will-navigate", (event, destination) => {
      if (!allowDocument(destination)) event.preventDefault();
    });
    contents.on("will-frame-navigate", (details) => {
      if (!details.isMainFrame) details.preventDefault();
    });
    contents.on("will-redirect", (event, destination) => {
      if (!allowDocument(destination)) event.preventDefault();
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url: destination }) => {
      if (destination === settingsUrl) this.openToolSettings();

      return { action: "deny" };
    });

    try {
      await window.loadURL(url.href);

      if (!window.isDestroyed()) window.show();
    } catch (cause) {
      if (window.isDestroyed()) return;
      window.destroy();
      throw cause;
    }
  }
}
