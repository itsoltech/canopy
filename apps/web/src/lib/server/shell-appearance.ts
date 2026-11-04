import type { ui } from "@canopy/contracts";
import { call } from "./gateway.ts";

let cached: ui.AppearanceSettings | undefined;
let expires = 0;
let pending: Promise<ui.AppearanceSettings | undefined> | undefined;

/** Short process-local cache for the single development user. The shell never waits on a long outage. */
export function shellAppearance(): Promise<ui.AppearanceSettings | undefined> {
  if (Date.now() < expires) return Promise.resolve(cached);

  return (pending ??= call((api) => api.getSettings({}, { timeoutMs: 750 }))
    .then(
      (settings) => {
        cached = settings.user?.appearance;
        expires = Date.now() + 3000;

        return cached;
      },
      () => {
        expires = Date.now() + 1000;

        return cached;
      },
    )
    .finally(() => (pending = undefined)));
}
