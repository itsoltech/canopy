import { app, BrowserWindow, ipcMain, nativeImage } from "electron";
import type { IpcMainInvokeEvent, NativeImage, WebContents } from "electron";
import { Schema } from "effect";
import { maxNotificationBadge } from "@canopy/domain/notification-badge";
import type { DesktopStatus } from "@canopy/ui/desktop";
import { windowContents } from "./window-message.ts";

const badgeCount = Schema.decodeUnknownSync(
  Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: maxNotificationBadge })),
);

function isApplicationPage(url: string, origin: string | undefined) {
  const page = URL.parse(url);

  return page && page.origin === origin && page.pathname !== "/desktop" && !page.pathname.startsWith("/desktop/");
}

const iconSize = 16;

const digits = [
  0b111_101_101_101_111, 0b010_110_010_010_111, 0b111_001_111_100_111, 0b111_001_111_001_111, 0b101_101_111_001_001,
  0b111_100_111_001_111, 0b111_100_111_101_111, 0b111_001_010_010_010, 0b111_101_111_101_111, 0b111_101_111_001_111,
];

const plus = 0b000_010_111_010_000;

function windowsBadge(count: number) {
  const label = count > 99 ? "99+" : String(count);
  const bitmap = Buffer.alloc(iconSize * iconSize * 4);
  // Electron's Windows bitmap stores premultiplied BGRA pixels.
  const pixelOffset = (x: number, y: number) => (y * iconSize + x) * 4;

  for (let y = 1; y < iconSize - 1; y++) {
    const edge = Math.min(y, iconSize - 1 - y);
    const inset = edge === 1 ? 3 : edge === 2 ? 1 : 0;

    for (let x = inset; x < iconSize - inset; x++) bitmap.writeUInt32LE(0xffc22c3c, pixelOffset(x, y));
  }

  const scaleX = label.length === 1 ? 2 : 1;
  const width = 4 * scaleX * label.length - scaleX;
  const left = Math.floor((iconSize - width) / 2);

  for (const [index, character] of [...label].entries()) {
    const glyph = digits[Number(character)] ?? plus;

    for (let pixel = 0; pixel < 15; pixel++) {
      if (!(glyph & (1 << (14 - pixel)))) continue;
      const x = left + (4 * index + (pixel % 3)) * scaleX;
      const y = 3 + Math.floor(pixel / 3) * 2;

      bitmap.fill(0xff, pixelOffset(x, y), pixelOffset(x + scaleX, y));
      bitmap.fill(0xff, pixelOffset(x, y + 1), pixelOffset(x + scaleX, y + 1));
    }
  }

  return nativeImage.createFromBitmap(bitmap, { width: iconSize, height: iconSize });
}

/** All reporting windows share the current BFF target, so the last snapshot replaces the count. */
export class NotificationBadge {
  #status: DesktopStatus | undefined;
  #count = 0;
  #overlay: NativeImage | null = null;
  readonly #invalidated = new WeakSet<WebContents>();

  register(authorize: (event: IpcMainInvokeEvent) => void) {
    ipcMain.handle("canopy:notification-badge", (event, raw: number) => {
      authorize(event);
      const status = this.#status;

      if (
        !status ||
        !isApplicationPage(event.senderFrame?.url ?? "", status.webUrl) ||
        this.#invalidated.has(event.sender)
      )
        throw new Error("Untrusted notification badge request");
      const count = badgeCount(raw);

      if (status.phase === "running" && !status.needsPairing) this.#setCount(count);
    });
    app.on("browser-window-created", (_event, window) => {
      const contents = window.webContents;
      contents.on("did-navigate", () => this.#invalidated.delete(contents));

      if (process.platform !== "win32") return;
      const reapply = () => this.#applyOverlay(window);
      window.on("show", reapply);
      window.on("focus", reapply);
    });
  }

  statusChanged(next: DesktopStatus) {
    const previous = this.#status;

    if (
      previous &&
      ((next.needsPairing && !previous.needsPairing) ||
        next.mode !== previous.mode ||
        next.gatewayUrl !== previous.gatewayUrl ||
        next.webUrl !== previous.webUrl)
    )
      this.invalidate();
    this.#status = next;

    if (next.phase === "error" || next.phase === "stopping") this.clear();
  }

  invalidate() {
    this.clear();

    // Configuration can replace the BFF target while preserving the loopback origin.
    for (const window of BrowserWindow.getAllWindows()) {
      const contents = windowContents(window);

      if (contents && isApplicationPage(contents.getURL(), this.#status?.webUrl)) this.#invalidated.add(contents);
    }
  }

  clear() {
    this.#setCount(0);
  }

  #setCount(count: number) {
    if (count === this.#count) return;
    this.#count = count;

    if (process.platform === "darwin" || process.platform === "linux") app.setBadgeCount(count);

    if (process.platform !== "win32") return;
    this.#overlay = count ? windowsBadge(count) : null;

    for (const window of BrowserWindow.getAllWindows()) this.#applyOverlay(window);
  }

  #applyOverlay(window: BrowserWindow) {
    if (window.isDestroyed() || !window.isVisible()) return;
    const description = this.#count === 1 ? "1 unread notification" : `${this.#count} unread notifications`;
    window.setOverlayIcon(this.#overlay, this.#overlay ? description : "");
  }
}
