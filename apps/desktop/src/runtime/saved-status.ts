import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configuration, initialStatus } from "./config.ts";
import type { DesktopConfiguration, DesktopSavedConfiguration, DesktopStatus } from "@canopy/ui/desktop";
import { writePrivateFile } from "./private-file.ts";

export function writeConfiguration(directory: string, config: DesktopSavedConfiguration) {
  writePrivateFile(join(directory, "desktop.json"), JSON.stringify(config, null, 2) + "\n");
}

export function savedConfiguration(config: DesktopConfiguration, gatewayUrl?: string): DesktopSavedConfiguration {
  if (config.mode === "local") return config;

  return {
    mode: config.mode,
    gatewayUrl: gatewayUrl ?? config.gatewayUrl,
    workerGatewayUrl: config.workerGatewayUrl ?? config.gatewayUrl,
  };
}

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
      configuration: savedConfiguration(config),
      ...(config.mode === "remote" && { gatewayUrl: config.gatewayUrl }),
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
