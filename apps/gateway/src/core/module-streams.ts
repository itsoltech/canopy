import type { ui } from "@canopy/contracts";
import { enabledModules } from "@canopy/domain";

/** Existing streams retain the aborted signal when the owner re-enables the module. */
export class ModuleStreams {
  bots = new AbortController();
  threads = new AbortController();
  #version = -1n;

  update(settings: ui.UserSettings): boolean {
    if (settings.version <= this.#version) return false;
    this.#version = settings.version;
    const active = enabledModules(settings.modules);
    let changed = false;

    for (const module of enabledModules()) {
      const previous = this[module];
      const enabled = active.includes(module);

      if (enabled === !previous.signal.aborted) continue;
      changed = true;

      if (enabled) this[module] = new AbortController();
      else previous.abort();
    }

    return changed;
  }
}
