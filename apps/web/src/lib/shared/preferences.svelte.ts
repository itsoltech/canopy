/**
 * Appearance preferences of this browser (T3's Settings → Appearance): color scheme, accent theme and
 * chat width. Stored in localStorage; app.html applies them before first paint, this keeps them in sync.
 */
export type ColorScheme = "system" | "light" | "dark";
export type Accent = "default" | "grove" | "ocean" | "ember" | "iris" | "rose";
export type ChatWidth = "comfortable" | "wide" | "full";

interface Stored {
  scheme?: ColorScheme;
  accent?: Accent;
  chatWidth?: ChatWidth;
}

const KEY = "oa-prefs";

class Preferences {
  scheme = $state<ColorScheme>("system");
  accent = $state<Accent>("default");
  chatWidth = $state<ChatWidth>("comfortable");

  constructor() {
    if (typeof window === "undefined") return;
    try {
      const stored = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Stored;
      this.scheme = stored.scheme ?? "system";
      this.accent = stored.accent ?? "default";
      this.chatWidth = stored.chatWidth ?? "comfortable";
    } catch {
      // unreadable: defaults
    }
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.#apply());
  }

  update(change: Stored): void {
    if (change.scheme) this.scheme = change.scheme;
    if (change.accent) this.accent = change.accent;
    if (change.chatWidth) this.chatWidth = change.chatWidth;
    localStorage.setItem(KEY, JSON.stringify({ scheme: this.scheme, accent: this.accent, chatWidth: this.chatWidth }));
    this.#apply();
  }

  #apply(): void {
    const root = document.documentElement;
    const dark = this.scheme === "dark" || (this.scheme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    root.classList.toggle("dark", dark);
    root.dataset["accent"] = this.accent;
    root.dataset["chatWidth"] = this.chatWidth;
  }
}

export const preferences = new Preferences();
