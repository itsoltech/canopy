import type { ui } from "@canopy/contracts";
import { deviceAppearanceDefaults, legacyDeviceAppearance } from "@canopy/domain";
import { toast } from "#lib/shared/ui/toast.svelte.ts";
import { appearanceCookie, appearanceFromDocument, applyAppearance } from "./appearance.ts";
import { parseWebAppearance, serializeWebAppearance, type WebAppearance } from "./theme-customization.ts";
import type { ThemePreview } from "./settings-theme-preview.ts";

const cookiePrefix = `${appearanceCookie}=`;

function savedCookie(): string | undefined {
  return document.cookie
    .split("; ")
    .find((cookie) => cookie.startsWith(cookiePrefix))
    ?.slice(cookiePrefix.length);
}

function readAppearance(): WebAppearance | undefined {
  try {
    return parseWebAppearance(decodeURIComponent(savedCookie() ?? ""));
  } catch {
    return undefined;
  }
}

class AppearanceState {
  values = $state.raw<WebAppearance>(deviceAppearanceDefaults);
  preview = $state.raw<ThemePreview>();
  connected = $state(false);
  #initialized = false;
  #changes: BroadcastChannel | undefined;

  connect(): () => void {
    const saved = readAppearance();
    this.values = saved ?? appearanceFromDocument();
    this.#initialized = !!saved;
    const startup = window.canopyDesktop?.startupAppearance;

    if (!saved && (startup?.lightColors || startup?.darkColors || startup?.lightAccent || startup?.darkAccent))
      this.#save(this.values);

    this.connected = true;

    const refresh = () => {
      const next = readAppearance();

      if (next) {
        this.#initialized = true;
        this.values = next;
      }
    };

    this.#changes = new BroadcastChannel(appearanceCookie);
    this.#changes.addEventListener("message", refresh);
    const system = matchMedia("(prefers-color-scheme: dark)");

    const follow = () => {
      if (!this.preview) applyAppearance(this.values);
    };

    system.addEventListener("change", follow);

    return () => {
      this.#changes?.close();
      this.#changes = undefined;
      system.removeEventListener("change", follow);
      this.connected = false;
    };
  }

  initialize(legacy: ui.AppearanceSettings | undefined): void {
    if (this.#initialized) return;
    const saved = readAppearance();

    if (saved) {
      this.#initialized = true;
      this.values = saved;
    } else {
      this.#save(legacy ? legacyDeviceAppearance(legacy) : this.values);
    }
  }

  update(change: Partial<WebAppearance>): boolean {
    return this.#save({ ...this.values, ...change });
  }

  #save(next: WebAppearance): boolean {
    this.#initialized = true;
    this.values = next;
    const encoded = encodeURIComponent(serializeWebAppearance(next));
    const secure = location.protocol === "https:" ? "; Secure" : "";

    try {
      document.cookie = `${cookiePrefix}${encoded}; Path=/; Max-Age=34560000; SameSite=Lax${secure}`;

      if (savedCookie() !== encoded) throw new Error("Browser did not retain the appearance cookie");
      this.#changes?.postMessage(null);

      return true;
    } catch {
      toast("Could not save appearance. Allow cookies to keep your changes after reloading.", { tone: "error" });

      return false;
    }
  }
}

export const appearanceState = new AppearanceState();
