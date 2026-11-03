/**
 * Preloaded by `bun test` (bunfig.toml): at the end of the whole run, the temp directories no scope removed. bun
 * test fires no "exit" event, and a skipped describe still runs its body (making directories) but not its afterAll.
 */
import { afterAll } from "bun:test";
import { removeTempDirs } from "./temp.ts";

afterAll(removeTempDirs);

// Test settings from before the rename (OA_LIVE, OA_LIVE_CLIPROXYAPI_URL, ...) keep working as CANOPY_*.
for (const [name, value] of Object.entries(process.env)) {
  const renamed = `CANOPY_${name.slice("OA_".length)}`;
  if (name.startsWith("OA_") && process.env[renamed] === undefined) process.env[renamed] = value;
}
