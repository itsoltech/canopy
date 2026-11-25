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
import { createActivityNotchWindow, positionActivityNotchWindow } from "./activity-notch-window.ts";
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

const decodeItems = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      path: Schema.String,
      state: Schema.Literals(["working", "approval", "answer", "completed", "failed"]),
      projectMark: Schema.optionalKey(projectMark.pipe(Schema.catchDecoding(() => Effect.succeedNone))),
    }),
  ).check(Schema.isMaxLength(maxActivityNotchItems)),
);

export const activityNotchSupported = process.platform === "darwin" || process.platform === "win32";

export interface ActivityNotchRow {
  id: number;
  kind: "Thread" | "Bot";
  number: number;
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
  #numbers = { Thread: 0, Bot: 0 };
  #expanded = false;
  #loaded = false;
  #headerHeight: number | undefined;
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
      if (!this.#fromNotch(event) || (expanded !== true && expanded !== false)) return;
      this.#expanded = expanded;
      this.#position();
    });
    ipcMain.on("canopy:activity-notch-open", (event, id: number) => {
      if (!this.#fromNotch(event) || !this.#expanded) return;
      const entry = this.#entries.find((row) => row.id === id);

      if (entry) {
        this.#hide();
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

    source.on("focus", this.#syncVisibility);
    source.on("blur", this.#syncVisibility);
    source.on("minimize", this.#syncVisibility);
    source.on("hide", this.#syncVisibility);
    source.on("show", this.#syncVisibility);
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
    this.#numbers = { Thread: 0, Bot: 0 };
    this.#destroyWindow();
  }

  #update(items: readonly ActivityNotchItem[]) {
    const byPath = new Map<string, ActivityNotchItem>();

    for (const item of items) {
      if (!isDesktopActivityRoute(item.path)) throw new Error("Invalid activity notch route");
      byPath.set(item.path, item);
    }

    if (!byPath.size) {
      this.clear();

      return;
    }

    const previous = new Map(this.#entries.map((entry) => [entry.path, entry]));

    const entries = Array.from(byPath.values(), ({ path, state, projectMark }): Entry => {
      const before = previous.get(path);
      const kind = path.startsWith("/threads/") ? "Thread" : "Bot";

      return {
        path,
        state,
        kind,
        id: before?.id ?? ++this.#nextId,
        number: before?.number ?? ++this.#numbers[kind],
        ...(kind === "Thread" && projectMark && { projectMark }),
      };
    });

    if (
      entries.length === this.#entries.length &&
      entries.every((entry, index) => {
        const old = this.#entries[index];

        return old?.id === entry.id && old.state === entry.state && sameProjectMark(old.projectMark, entry.projectMark);
      })
    )
      return;

    this.#entries = entries;
    this.#sendRows();
    this.#syncVisibility();
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

    const rows: ActivityNotchRow[] = this.#entries.map(({ id, kind, number, state, projectMark }) => ({
      id,
      kind,
      number,
      state,
      ...(projectMark && { projectMark }),
    }));

    sendWindowMessage(this.#target, (contents) => contents.send("canopy:activity-notch-rows", rows));
  }

  #displayChanged = () => {
    this.#headerHeight = undefined;
    this.#position();
  };

  #position(show = false) {
    const target = this.#target;

    if (!this.#loaded || !target || target.isDestroyed()) return;

    const expandedRows = this.#expanded ? this.#entries.length : 0;
    let { headerHeight, moved } = positionActivityNotchWindow(target, expandedRows, this.#headerHeight);

    if (show) {
      target.showInactive();

      if (process.platform === "win32") {
        const visible = positionActivityNotchWindow(target, expandedRows, headerHeight);
        headerHeight = visible.headerHeight;
        moved ||= visible.moved;
      }
    }

    if (moved || this.#headerHeight !== headerHeight) {
      this.#headerHeight = headerHeight;
      sendWindowMessage(target, (contents) => contents.send("canopy:activity-notch-height", headerHeight));
    }
  }

  #hide() {
    if (this.#target?.isVisible()) this.#target.hide();

    if (!this.#expanded) return;
    this.#expanded = false;
    this.#position();
    sendWindowMessage(this.#target, (contents) => contents.send("canopy:activity-notch-collapse"));
  }

  #syncVisibility = () => {
    const source = this.#source;

    if (!this.#entries.length || !source || source.isDestroyed() || source.isFocused()) {
      this.#hide();

      return;
    }

    if (!this.#target) this.#createWindow();
    else this.#position(!this.#target.isVisible());
  };

  #destroyWindow() {
    const target = this.#target;
    this.#target = undefined;
    this.#loaded = false;
    this.#headerHeight = undefined;
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
        this.#syncVisibility();

        if (!target.isVisible()) this.#position();
        this.#sendRows();
      })
      .catch(() => {
        if (this.#target === target) this.#destroyWindow();
      });
  }
}
