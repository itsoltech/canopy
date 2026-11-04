import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { QuitShortcut } from "@canopy/ui/desktop";

export function isQuitShortcut(value: unknown): value is QuitShortcut {
  return value === "press-twice" || value === "hold" || value === "immediately";
}

function isShortcutSettings(value: unknown): value is { quitShortcut: unknown } {
  return !!value && typeof value === "object" && "quitShortcut" in value;
}

function isMissingFile(cause: unknown): cause is NodeJS.ErrnoException {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

/** Local desktop preference, independent of gateway credentials and update channel. */
export class QuitSettings {
  private readonly path: string;
  constructor(directory: string) {
    this.path = join(directory, "app-shortcuts.json");
  }
  read(): QuitShortcut {
    try {
      const value: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      const shortcut = isShortcutSettings(value) ? value.quitShortcut : undefined;

      return isQuitShortcut(shortcut) ? shortcut : "press-twice";
    } catch (error) {
      if (error instanceof SyntaxError || isMissingFile(error)) return "press-twice";
      throw error;
    }
  }
  write(quitShortcut: QuitShortcut) {
    writeFileSync(`${this.path}.tmp`, JSON.stringify({ quitShortcut }) + "\n", { mode: 0o600 });
    renameSync(`${this.path}.tmp`, this.path);
  }
}
