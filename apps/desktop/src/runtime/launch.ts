import { join } from "node:path";
import type { RuntimePaths } from "./runtime.ts";

/** One native Bun executable runs all bundled JS services on every platform. */
export function runtimePaths(directory: string, platform = process.platform): RuntimePaths {
  return {
    bun: join(directory, platform === "win32" ? "bun.exe" : "bun"),
    gateway: join(directory, "canopy-gateway.js"),
    worker: join(directory, "canopy-worker.js"),
    web: join(directory, "canopy-web.js"),
    postgres: join(directory, "postgres.json"),
  };
}

export const controllerEntry = (directory: string) => join(directory, "canopy-controller.js");
