import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, screen, type BrowserWindow } from "electron";
import { Schema } from "effect";
import { restoredBounds, type Rect, type SizeLimits } from "./window-bounds.ts";

const Stored = Schema.Struct({
  bounds: Schema.Struct({ x: Schema.Number, y: Schema.Number, width: Schema.Number, height: Schema.Number }),
  maximized: Schema.Boolean,
  fullScreen: Schema.Boolean,
  displayId: Schema.optional(Schema.Number),
});

type SavedWindowState = typeof Stored.Type;

const SAVE_DELAY_MS = 500;

function usable(state: SavedWindowState) {
  const { x, y, width, height } = state.bounds;

  return [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0;
}

/** Position, size and display of the main window. Local to this machine, never sent to the gateway. */
export class WindowStateStore {
  private readonly path: string;
  constructor(directory: string) {
    this.path = join(directory, "window-state.json");
  }
  read(): SavedWindowState | undefined {
    try {
      const state = Schema.decodeUnknownSync(Stored)(JSON.parse(readFileSync(this.path, "utf8")));

      return usable(state) ? state : undefined;
    } catch (cause) {
      if (
        (cause instanceof Error && "code" in cause && cause.code === "ENOENT") ||
        cause instanceof SyntaxError ||
        Schema.isSchemaError(cause)
      )
        return undefined;
      throw cause;
    }
  }
  write(state: SavedWindowState) {
    writeFileSync(`${this.path}.tmp`, JSON.stringify(state) + "\n", { mode: 0o600 });
    renameSync(`${this.path}.tmp`, this.path);
  }
}

export interface WindowPlacement {
  bounds: Partial<Rect>;
  /** Runs after the first show, so un-maximizing returns to the saved normal bounds. */
  restore: (target: BrowserWindow) => void;
  track: (target: BrowserWindow) => void;
}

function snapshot(target: BrowserWindow): SavedWindowState {
  const bounds = target.getNormalBounds();

  return {
    bounds,
    maximized: target.isMaximized(),
    fullScreen: target.isFullScreen(),
    displayId: screen.getDisplayMatching(bounds).id,
  };
}

export function windowPlacement(directory: string, limits: SizeLimits): WindowPlacement {
  const store = new WindowStateStore(directory);
  const saved = store.read();

  const bounds =
    saved &&
    restoredBounds(
      saved.bounds,
      saved.displayId,
      screen.getAllDisplays().map(({ id, workArea }) => ({ id, workArea })),
      limits,
    );

  let tracked: BrowserWindow | undefined;
  let latest: SavedWindowState | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // A hidden or minimized window reports unreliable flags on some platforms; keep the last real state.
  const capture = () => {
    if (tracked && !tracked.isDestroyed() && tracked.isVisible() && !tracked.isMinimized()) latest = snapshot(tracked);
  };

  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    capture();

    try {
      if (latest) store.write(latest);
    } catch {
      /* A failed write keeps the previous state; it must not block closing or quitting. */
    }
  };

  const schedule = () => {
    capture();
    clearTimeout(timer);
    timer = setTimeout(flush, SAVE_DELAY_MS);
  };

  return {
    bounds: bounds ?? {},
    restore: (target) => {
      if (!bounds || !saved) return;

      if (saved.fullScreen) target.setFullScreen(true);
      else if (saved.maximized) target.maximize();
    },
    track: (target) => {
      tracked = target;

      target.on("move", schedule);
      target.on("resize", schedule);
      target.on("maximize", schedule);
      target.on("unmaximize", schedule);
      target.on("enter-full-screen", schedule);
      target.on("leave-full-screen", schedule);
      target.on("close", flush);
      // Quit hides windows first; the hidden window keeps the state captured before.
      app.on("before-quit", flush);
      target.once("closed", () => {
        clearTimeout(timer);
        app.removeListener("before-quit", flush);
        tracked = undefined;
      });
    },
  };
}
