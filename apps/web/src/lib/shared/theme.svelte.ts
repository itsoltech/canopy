/** Appearance: system (default), light or dark. Stored per browser; app.html applies it before first paint. */
export type ThemeChoice = "system" | "light" | "dark";

const KEY = "oa-theme";

class Theme {
  choice = $state<ThemeChoice>("system");

  constructor() {
    if (typeof window === "undefined") return;
    const stored = localStorage.getItem(KEY);
    if (stored === "light" || stored === "dark") this.choice = stored;
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.#apply());
  }

  set(choice: ThemeChoice): void {
    this.choice = choice;
    if (choice === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
    this.#apply();
  }

  #apply(): void {
    const dark = this.choice === "dark" || (this.choice === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
  }
}

export const theme = new Theme();
