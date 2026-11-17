import { mkdirSync, mkdtempSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ToolEnv } from "../agent-tools/paths.ts";

/** Screenshots can exceed a shared temp volume's per-user quota even when it has free space. */
export function screenshotDirectory(env: ToolEnv): string {
  const home = env["HOME"] || env["USERPROFILE"] || homedir();
  let cache: string;

  switch (process.platform) {
    case "darwin":
      cache = join(home, "Library", "Caches");
      break;
    case "win32":
      cache = env["LOCALAPPDATA"] || join(home, "AppData", "Local");
      break;
    default: {
      const configured = env["XDG_CACHE_HOME"];
      cache = configured && isAbsolute(configured) ? configured : join(home, ".cache");
    }
  }

  const root = join(cache, "canopy", "agent-preview");
  mkdirSync(root, { recursive: true, mode: 0o700 });

  return mkdtempSync(join(root, "capture-"));
}
