import type { ui } from "@canopy/contracts";
import {
  deviceAppearanceDefaults,
  legacyDeviceAppearance,
  parseDeviceAppearance,
  type DeviceAppearance,
} from "@canopy/domain";
import { toast } from "#lib/shared/ui/toast.svelte.ts";
import { appearanceCookie, appearanceFromDocument, applyAppearance } from "./appearance.ts";

const cookiePrefix = `${appearanceCookie}=`;

function savedCookie(): string | undefined {
  return document.cookie
    .split("; ")
    .find((cookie) => cookie.startsWith(cookiePrefix))
    ?.slice(cookiePrefix.length);
}

function readAppearance(): DeviceAppearance | undefined {
  try {
    return parseDeviceAppearance(decodeURIComponent(savedCookie() ?? ""));
  } catch {
    return undefined;
  }
}

class AppearanceState {
  values = $state.raw<DeviceAppearance>(deviceAppearanceDefaults);
  connected = $state(false);
  #initialized = false;
  #changes: BroadcastChannel | undefined;

  connect(): () => void {
    const saved = readAppearance();
    this.values = saved ?? appearanceFromDocument();
    this.#initialized = !!saved;
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
    const follow = () => applyAppearance(this.values);
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

  update(change: Partial<DeviceAppearance>): void {
    this.#save({ ...this.values, ...change });
  }

  #save(next: DeviceAppearance): void {
    this.#initialized = true;
    this.values = next;
    const encoded = encodeURIComponent(JSON.stringify(next));
    const secure = location.protocol === "https:" ? "; Secure" : "";

    try {
      document.cookie = `${cookiePrefix}${encoded}; Path=/; Max-Age=34560000; SameSite=Lax${secure}`;

      if (savedCookie() !== encoded) throw new Error("Browser did not retain the appearance cookie");
      this.#changes?.postMessage(null);
    } catch {
      toast("Could not save appearance. Allow cookies to keep your changes after reloading.", { tone: "error" });
    }
  }
}

export const appearanceState = new AppearanceState();
