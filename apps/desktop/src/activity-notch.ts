import { ipcMain, screen, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { Effect, Schema } from "effect";
import {
  activityNotchLogoSize,
  isDesktopActivityRoute,
  maxActivityNotchItems,
  type ActivityNotchItem,
  type ActivityNotchProjectMark,
  type DesktopStatus,
} from "@canopy/ui/desktop";
import { activityNotchVisibleRows, type ActivityNotchLayout } from "./activity-notch-geometry.ts";
import {
  createActivityNotchWindow,
  positionActivityNotchWindow,
  setActivityNotchInteractive,
} from "./activity-notch-window.ts";
import { sendWindowMessage, windowContents } from "./window-message.ts";

// The 36 × 36 RGBA buffer is divisible by three, so its base64 has no padding.
const logoLength = Math.ceil((activityNotchLogoSize ** 2 * 4) / 3) * 4;

const pixels = Schema.String.check(
  Schema.isBetweenLength(logoLength, logoLength),
  Schema.isPattern(/^[A-Za-z0-9+/]+$/),
);

// An invalid thumbnail falls back to initials. Invalid initials or colors leave the row unmarked.
const projectMark = Schema.Struct({
  initials: Schema.String.check(Schema.isPattern(/^(?:[\p{L}\p{M}\p{N}]{1,4}|\?)$/u)),
  foreground: Schema.String.check(Schema.isPattern(/^#[\da-f]{6}$/i)),
  background: Schema.String.check(Schema.isPattern(/^#[\da-f]{6}(?:[\da-f]{2})?$/i)),
  pixels: Schema.optionalKey(pixels.pipe(Schema.catchDecoding(() => Effect.succeedNone))),
});

const threadTitle = Schema.String.check(Schema.isMaxLength(200));
const numbers = new Intl.NumberFormat("en");

const decodeItems = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      path: Schema.String,
      state: Schema.Literals(["working", "approval", "answer", "completed", "failed"]),
      title: Schema.optionalKey(threadTitle.pipe(Schema.catchDecoding(() => Effect.succeedNone))),
      projectMark: Schema.optionalKey(projectMark.pipe(Schema.catchDecoding(() => Effect.succeedNone))),
    }),
  ).check(Schema.isMaxLength(maxActivityNotchItems)),
);

export const activityNotchSupported = process.platform === "darwin" || process.platform === "win32";

export interface ActivityNotchRow {
  id: number;
  label: string;
  state: ActivityNotchItem["state"];
  projectMark?: ActivityNotchProjectMark | undefined;
}

interface Entry extends ActivityNotchRow {
  path: string;
}

function sameProjectMark(left?: ActivityNotchProjectMark, right?: ActivityNotchProjectMark) {
  return (
    left?.initials === right?.initials &&
    left?.foreground === right?.foreground &&
    left?.background === right?.background &&
    left?.pixels === right?.pixels
  );
}

function applicationOrigin(url: string): string | undefined {
  const page = URL.parse(url);

  if (!page || page.pathname === "/desktop" || page.pathname.startsWith("/desktop/")) return undefined;

  return page.origin;
}

export class ActivityNotch {
  #source: BrowserWindow | undefined;
  #target: BrowserWindow | undefined;
  #status: DesktopStatus | undefined;
  #entries: Entry[] = [];
  #nextId = 0;
  #botNumber = 0;
  #expanded = false;
  #loaded = false;
  #layout: ActivityNotchLayout | undefined;
  #rowsRevision = 0;
  #reservedRows = 0;
  #invalidated = false;

  constructor(private readonly openRoute: (path: string) => void) {}

  register(authorize: (event: IpcMainInvokeEvent) => void) {
    if (!activityNotchSupported) return;
    ipcMain.handle("canopy:activity-notch", (event, raw: readonly ActivityNotchItem[]) => {
      authorize(event);

      if (
        event.sender !== windowContents(this.#source) ||
        this.#invalidated ||
        !this.#status?.webUrl ||
        applicationOrigin(event.senderFrame?.url ?? "") !== this.#status.webUrl
      )
        throw new Error("Untrusted activity notch request");

      if (this.#status.phase === "running" && !this.#status.needsPairing) this.#update(decodeItems(raw));
    });
    ipcMain.on("canopy:activity-notch-expanded", (event, expanded: boolean) => {
      if (!this.#fromNotch(event) || !this.#entries.length || (expanded !== true && expanded !== false)) return;

      if (expanded === this.#expanded) return;
      this.#expanded = expanded;
      this.#position();
    });
    ipcMain.on("canopy:activity-notch-interactive", (event, interactive: boolean) => {
      if (this.#fromNotch(event) && this.#target && (interactive === true || interactive === false))
        setActivityNotchInteractive(this.#target, interactive);
    });
    ipcMain.on("canopy:activity-notch-layout-settled", (event, revision: number) => {
      if (!this.#fromNotch(event) || !this.#entries.length || revision !== this.#layout?.revision) return;

      if (this.#reservedRows === this.#expandedRows) return;
      this.#reservedRows = this.#expandedRows;
      this.#position();
    });
    ipcMain.on("canopy:activity-notch-hidden", (event, revision: number) => {
      if (this.#fromNotch(event) && revision === this.#rowsRevision && !this.#entries.length) this.#destroyWindow();
    });
    ipcMain.on("canopy:activity-notch-open", (event, id: number) => {
      if (!this.#fromNotch(event) || !this.#expanded) return;
      const entry = this.#entries.find((row) => row.id === id);

      if (entry) {
        this.#expanded = false;
        sendWindowMessage(this.#target, (contents) => contents.send("canopy:activity-notch-collapse"));
        this.#position();
        this.openRoute(entry.path);
      }
    });
    screen.on("display-added", this.#displayChanged);
    screen.on("display-removed", this.#displayChanged);
    screen.on("display-metrics-changed", this.#displayChanged);
  }

  track(source: BrowserWindow) {
    if (!activityNotchSupported) return;
    this.#source = source;
    this.#invalidated = false;

    source.webContents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) this.clear();
    });
    source.webContents.on("did-navigate", () => (this.#invalidated = false));
    source.webContents.on("render-process-gone", () => this.clear());
    source.on("closed", () => {
      this.#source = undefined;
      this.clear();
    });
  }

  statusChanged(next: DesktopStatus) {
    const previous = this.#status;
    this.#status = next;

    if (
      previous &&
      (next.mode !== previous.mode ||
        next.gatewayUrl !== previous.gatewayUrl ||
        next.webUrl !== previous.webUrl ||
        (next.needsPairing && !previous.needsPairing))
    )
      this.invalidate();
    else if (next.phase !== "running") this.clear();
  }

  invalidate() {
    this.#invalidated = true;
    this.clear();
  }

  clear() {
    this.#entries = [];
    this.#botNumber = 0;
    this.#destroyWindow();
  }

  #update(items: readonly ActivityNotchItem[]) {
    const byPath = new Map<string, ActivityNotchItem>();

    for (const item of items) {
      if (!isDesktopActivityRoute(item.path)) throw new Error("Invalid activity notch route");
      byPath.set(item.path, item);
    }

    if (!byPath.size) {
      if (this.#entries.length) {
        this.#entries = [];
        this.#botNumber = 0;
        this.#expanded = false;

        if (this.#loaded) this.#sendRows();
        else this.#destroyWindow();
      }

      return;
    }

    const previous = new Map(this.#entries.map((entry) => [entry.path, entry]));

    const entries = Array.from(byPath.values(), ({ path, state, title, projectMark }): Entry => {
      const before = previous.get(path);
      const isThread = path.startsWith("/threads/");

      const label = isThread
        ? title?.trim() || "Untitled thread"
        : (before?.label ?? `Bot ${numbers.format(++this.#botNumber)}`);

      return {
        path,
        state,
        label,
        id: before?.id ?? ++this.#nextId,
        ...(isThread && projectMark && { projectMark }),
      };
    });

    if (
      entries.length === this.#entries.length &&
      entries.every((entry, index) => {
        const old = this.#entries[index];

        return (
          old?.id === entry.id &&
          old.label === entry.label &&
          old.state === entry.state &&
          sameProjectMark(old.projectMark, entry.projectMark)
        );
      })
    )
      return;

    this.#entries = entries;

    if (this.#target) {
      this.#position();
      this.#sendRows();
    } else this.#createWindow();
  }

  #fromNotch(event: IpcMainEvent) {
    return (
      event.sender === windowContents(this.#target) &&
      event.senderFrame === event.sender.mainFrame &&
      this.#target?.isVisible()
    );
  }

  #sendRows() {
    if (!this.#loaded) return;

    const rows: ActivityNotchRow[] = this.#entries.map(({ id, label, state, projectMark }) => ({
      id,
      label,
      state,
      ...(projectMark && { projectMark }),
    }));

    const revision = ++this.#rowsRevision;
    sendWindowMessage(this.#target, (contents) => contents.send("canopy:activity-notch-rows", rows, revision));
  }

  #displayChanged = () => this.#position({ displayChanged: true });

  get #expandedRows() {
    return this.#expanded ? Math.min(this.#entries.length, activityNotchVisibleRows) : 0;
  }

  #position({ show = false, displayChanged = false } = {}) {
    const target = this.#target;

    if (!this.#entries.length || !this.#loaded || !target || target.isDestroyed()) return;

    const rows = this.#expandedRows;
    const previous = this.#layout;
    // Grow the native window before the animation. Keep the old space until the current animation finishes.
    this.#reservedRows = Math.max(this.#reservedRows, rows);

    let size = positionActivityNotchWindow(
      target,
      rows,
      this.#reservedRows,
      displayChanged ? undefined : previous?.headerHeight,
    );

    if (show) {
      target.showInactive();

      if (process.platform === "win32") {
        size = positionActivityNotchWindow(target, rows, this.#reservedRows, size.headerHeight);
      }
    }

    if (
      this.#reservedRows === rows &&
      previous?.width === size.width &&
      previous.height === size.height &&
      previous.headerHeight === size.headerHeight &&
      previous.center === size.center
    )
      return;

    const layout = { ...size, revision: (previous?.revision ?? 0) + 1 };
    this.#layout = layout;
    sendWindowMessage(target, (contents) => contents.send("canopy:activity-notch-layout", layout));
  }

  #destroyWindow() {
    const target = this.#target;
    this.#target = undefined;
    this.#loaded = false;
    this.#layout = undefined;
    this.#reservedRows = 0;
    this.#expanded = false;

    if (target && !target.isDestroyed()) target.destroy();
  }

  #createWindow() {
    const { target, load } = createActivityNotchWindow();
    this.#target = target;
    target.on("closed", () => {
      if (this.#target === target) this.#destroyWindow();
    });
    target.webContents.on("render-process-gone", () => {
      if (this.#target === target) this.#destroyWindow();
    });
    void load()
      .then(() => {
        if (this.#target !== target) return;
        this.#loaded = true;
        this.#position({ show: true });
        this.#sendRows();
      })
      .catch(() => {
        if (this.#target === target) this.#destroyWindow();
      });
  }
}
