import type { ui } from "@canopy/contracts";
import { call } from "./gateway.ts";

let cached: ui.AppearanceSettings | undefined;
let expires = 0;
let pending: Promise<ui.AppearanceSettings | undefined> | undefined;
let revision = 0;

/** A confirmed write must also reach a reload inside the shell cache's three-second window. */
export function cacheShellAppearance(appearance: ui.AppearanceSettings | undefined): void {
  revision++;
  cached = appearance;
  expires = Date.now() + 3000;
}

/** Short process-local cache for the single development user. The shell never waits on a long outage. */
export function shellAppearance(): Promise<ui.AppearanceSettings | undefined> {
  if (Date.now() < expires) return Promise.resolve(cached);
  const started = revision;

  return (pending ??= call((api) => api.getSettings({}, { timeoutMs: 750 }))
    .then(
      (settings) => {
        if (started === revision) {
          cached = settings.user?.appearance;
          expires = Date.now() + 3000;
        }

        return cached;
      },
      () => {
        expires = Date.now() + 1000;

        return cached;
      },
    )
    .finally(() => (pending = undefined)));
}
