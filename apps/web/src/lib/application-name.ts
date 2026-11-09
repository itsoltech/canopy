import { browser } from "$app/env";

/** The server resolves this from the running gateway before the SPA starts. */
export const applicationName = browser ? (document.documentElement.dataset["applicationName"] ?? "Canopy") : "Canopy";
