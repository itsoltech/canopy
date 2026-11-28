import type { ClientInit, HandleClientError } from "@sveltejs/kit/hooks";
import { applyMotionPreferences } from "#lib/features/settings/apply-motion.ts";
import { devicePreferences } from "#lib/features/settings/device-preferences.svelte.ts";
import { isModuleFetchError } from "#lib/shared/updates.ts";
import { updateNotice } from "#lib/shared/updates.svelte.ts";

export const init: ClientInit = () => {
  // Apply the saved motion settings before the first route starts its intro transitions.
  const disconnect = devicePreferences.connect();
  import.meta.hot?.dispose(disconnect);
  applyMotionPreferences();

  // Never `preventDefault()` here: Vite then resolves the failed import to `undefined`, and SvelteKit
  // reads a route node from it. The rejection reaches the caller, and routes show `+error.svelte`.
  window.addEventListener("vite:preloadError", () => updateNotice.detect(true));
  window.addEventListener("unhandledrejection", (event) => updateNotice.detect(false, event.reason));
};

export const handleError: HandleClientError = ({ error }) => {
  updateNotice.detect(false, error);

  // SvelteKit reloads by itself when the version changed; this is a download that failed meanwhile.
  if (isModuleFetchError(error)) return { message: "Could not load this page", scope: "assets" };
};
