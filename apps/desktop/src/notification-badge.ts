import { app, BrowserWindow, ipcMain, nativeImage } from "electron";
import type { IpcMainInvokeEvent, NativeImage, WebContents } from "electron";
import { Schema } from "effect";
import { maxNotificationBadge } from "@canopy/domain/notification-badge";
import type { DesktopStatus } from "@canopy/ui/desktop";
import { windowContents } from "./window-message.ts";
import { isApplicationPage } from "./window-permissions.ts";

const badgeCount = Schema.decodeUnknownSync(
  Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: maxNotificationBadge })),
);

const iconSize = 16;

// Each hex digit is the coverage of one pixel, from red (0) to white (f).
const digits = [
  ["07a70", "9fdf9", "da0ad", "e808e", "e808e", "da0ad", "9fdf9", "07a70"],
  ["02a30", "5ef70", "6bf70", "02f70", "02f70", "02f70", "6fffa", "28884"],
  ["18a81", "bfdfb", "960ae", "005fa", "06fc1", "7fb10", "efffc", "58885"],
  ["18a81", "bfdfa", "541bd", "09ffa", "038dd", "740ae", "cfdf9", "28a70"],
  ["00481", "01df4", "0bff4", "7fbf4", "efdfc", "9bcfa", "005f4", "00181"],
  ["49996", "9fee9", "bd630", "cfff6", "763cd", "740ad", "cfdf9", "28a70"],
  ["07a81", "7fdf8", "dc551", "efff7", "ec4bd", "ea0ae", "9fdf9", "07a81"],
  ["68886", "ceffd", "006f7", "00dc0", "04f60", "07f20", "09e00", "04600"],
  ["07a70", "8fdf8", "bd1db", "8fff8", "dd8dd", "e909e", "afdfa", "18a81"],
  ["18a70", "9fdf9", "ea0ae", "db4ce", "7fffe", "155cd", "8fdf7", "18a70"],
] as const;

const compactNine = ["2881", "beeb", "f67f", "e76f", "8fff", "139e", "aee9", "2881"] as const;

// The plus has a blank first column for extra space after the second nine.
const plus = ["0000", "0000", "0181", "06f6", "0fff", "06f6", "0181", "0000"] as const;

function windowsBadge(count: number) {
  const bitmap = Buffer.alloc(iconSize * iconSize * 4);
  // Electron's Windows bitmap stores premultiplied BGRA pixels.
  const pixelOffset = (x: number, y: number) => (y * iconSize + x) * 4;

  for (let y = 1; y < iconSize - 1; y++) {
    const edge = Math.min(y, iconSize - 1 - y);
    const inset = edge === 1 ? 3 : edge === 2 ? 1 : 0;

    for (let x = inset; x < iconSize - inset; x++) bitmap.writeUInt32LE(0xffc22c3c, pixelOffset(x, y));
  }

  const glyphs =
    count > 99
      ? [compactNine, compactNine, plus]
      : Array.from(String(count), (digit) => digits[Number(digit)] ?? digits[0]);

  const gap = glyphs.length === 3 ? 1 : 2;
  const width = glyphs.reduce((width, glyph) => width + glyph[0].length, (glyphs.length - 1) * gap);
  const top = Math.floor((iconSize - digits[0].length) / 2);
  let left = Math.floor((iconSize - width) / 2);

  for (const glyph of glyphs) {
    for (const [y, row] of glyph.entries()) {
      for (const [x, level] of Array.from(row).entries()) {
        if (level === "0") continue;
        const coverage = Number.parseInt(level, 16) / 15;
        const offset = pixelOffset(left + x, top + y);

        for (let channel = offset; channel < offset + 3; channel++) {
          const background = bitmap.readUInt8(channel);
          bitmap[channel] = Math.round(background + (255 - background) * coverage);
        }
      }
    }

    left += glyph[0].length + gap;
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
