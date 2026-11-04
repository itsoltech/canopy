import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configuration, initialStatus } from "./config.ts";
import type { DesktopStatus } from "@canopy/ui/desktop";

/** Resolve the startup surface before the first renderer can ask for status. */
export function savedStatus(directory: string): DesktopStatus {
  const state = initialStatus();
  const saved = join(directory, "desktop.json");

  if (!existsSync(saved)) return state;

  try {
    const config = configuration(JSON.parse(readFileSync(saved, "utf8")));

    return {
      ...state,
      phase: "starting",
      mode: config.mode,
      ...(config.mode === "remote" && { gatewayUrl: config.gatewayUrl, webUrl: config.webUrl }),
      allowNetwork: config.mode === "local" && config.allowNetwork,
      bindHost: config.mode === "local" ? config.bindHost : "127.0.0.1",
    };
  } catch {
    return {
      ...state,
      phase: "error",
      error: "Could not read desktop settings. Open desktop settings to choose a mode.",
    };
  }
}
