import { ipcMain, screen, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { Schema } from "effect";
import {
  isDesktopActivityRoute,
  maxActivityNotchItems,
  type ActivityNotchItem,
  type DesktopStatus,
} from "@canopy/ui/desktop";
import { createActivityNotchWindow, primaryActivityNotchGeometry } from "./activity-notch-window.ts";
import { sendWindowMessage, windowContents } from "./window-message.ts";

const decodeItems = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      path: Schema.String,
      state: Schema.Literals(["working", "approval", "answer", "completed", "failed"]),
    }),
  ).check(Schema.isMaxLength(maxActivityNotchItems)),
);

export const activityNotchSupported = process.platform === "darwin" || process.platform === "win32";

export interface ActivityNotchRow {
  id: number;
  kind: "Thread" | "Bot";
  number: number;
  state: ActivityNotchItem["state"];
}

interface Entry extends ActivityNotchRow {
  path: string;
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
    screen.on("display-added", this.#position);
    screen.on("display-removed", this.#position);
    screen.on("display-metrics-changed", this.#position);
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
    const byPath = new Map<string, ActivityNotchItem["state"]>();

    for (const { path, state } of items) {
      if (!isDesktopActivityRoute(path)) throw new Error("Invalid activity notch route");
      byPath.set(path, state);
    }

    if (!byPath.size) {
      this.clear();

      return;
    }

    const previous = new Map(this.#entries.map((entry) => [entry.path, entry]));

    const entries = Array.from(byPath, ([path, state]): Entry => {
      const before = previous.get(path);
      const kind = path.startsWith("/threads/") ? "Thread" : "Bot";

      return before ? { ...before, state } : { path, state, kind, id: ++this.#nextId, number: ++this.#numbers[kind] };
    });

    if (
      entries.length === this.#entries.length &&
      entries.every(
        (entry, index) => entry.id === this.#entries[index]?.id && entry.state === this.#entries[index]?.state,
      )
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
    const rows: ActivityNotchRow[] = this.#entries.map(({ id, kind, number, state }) => ({ id, kind, number, state }));
    sendWindowMessage(this.#target, (contents) => contents.send("canopy:activity-notch-rows", rows));
  }

  #position = () => {
    const target = this.#target;

    if (!target || target.isDestroyed()) return;

    const { bounds, headerHeight } = primaryActivityNotchGeometry(this.#expanded ? this.#entries.length : 0);
    const current = target.getBounds();

    const moved =
      current.x !== bounds.x ||
      current.y !== bounds.y ||
      current.width !== bounds.width ||
      current.height !== bounds.height;

    if (moved) target.setBounds(bounds);

    if (this.#loaded && (moved || this.#headerHeight !== headerHeight)) {
      this.#headerHeight = headerHeight;
      sendWindowMessage(target, (contents) => contents.send("canopy:activity-notch-height", headerHeight));
    }
  };

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
    else if (this.#loaded) {
      this.#position();

      if (!this.#target.isVisible()) this.#target.showInactive();
    }
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
        this.#position();
        this.#sendRows();
        this.#syncVisibility();
      })
      .catch(() => {
        if (this.#target === target) this.#destroyWindow();
      });
  }
}
