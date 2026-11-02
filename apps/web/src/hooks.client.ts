import type { ClientInit, HandleClientError } from "@sveltejs/kit/hooks";
import { updateNotice } from "#lib/shared/updates.svelte.ts";

export const init: ClientInit = () => {
  window.addEventListener("vite:preloadError", (event) => {
    // Keep the current composer intact, including when a lazy dialog or grammar fails to load.
    event.preventDefault();
    updateNotice.detect(true);
  });
  window.addEventListener("unhandledrejection", (event) => updateNotice.detect(false, event.reason));
};

export const handleError: HandleClientError = ({ error }) => {
  updateNotice.detect(false, error);
};
