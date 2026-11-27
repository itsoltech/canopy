import { toast } from "#lib/shared/ui/toast.svelte.ts";
import { parseCustomThemes, serializeCustomThemes, type CustomTheme } from "./custom-themes.ts";

const storageKey = "canopy-custom-themes";

/**
 * The custom themes of this device. The appearance cookie holds the resolved colors of the chosen themes, so this
 * library is needed only to list, choose and edit them, never for the first render.
 */
class CustomThemeLibrary {
  list = $state.raw<readonly CustomTheme[]>([]);

  connect(): () => void {
    this.reload();

    const changed = (event: StorageEvent) => {
      if (event.key === storageKey || event.key === null) this.reload();
    };

    addEventListener("storage", changed);

    return () => removeEventListener("storage", changed);
  }

  /** Another tab may have written the library just before its appearance change reached this one. */
  reload(): void {
    try {
      this.list = parseCustomThemes(localStorage.getItem(storageKey));
    } catch {
      this.list = [];
    }
  }

  find(id: string | undefined): CustomTheme | undefined {
    return id === undefined ? undefined : this.list.find((theme) => theme.id === id);
  }

  save(theme: CustomTheme): boolean {
    const exists = this.list.some((candidate) => candidate.id === theme.id);

    return this.#write(
      exists ? this.list.map((candidate) => (candidate.id === theme.id ? theme : candidate)) : [...this.list, theme],
    );
  }

  remove(id: string): boolean {
    return this.#write(this.list.filter((theme) => theme.id !== id));
  }

  #write(next: readonly CustomTheme[]): boolean {
    try {
      if (next.length) localStorage.setItem(storageKey, serializeCustomThemes(next));
      else localStorage.removeItem(storageKey);
      this.list = next;

      return true;
    } catch {
      toast("Could not save the theme. Free up browser storage and try again.", { tone: "error" });

      return false;
    }
  }
}

export const customThemes = new CustomThemeLibrary();
