import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AppUpdateHistory } from "@canopy/domain/release/app-history";
import type { DesktopAppHistory } from "@canopy/ui/desktop";

/** Own app state follows the Electron profile, including switches between local and remote gateways. */
export function desktopAppHistory(directory: string, version: string): () => DesktopAppHistory {
  const path = join(directory, "app-update-history.json");

  const history = new AppUpdateHistory((raw) => {
    try {
      writeFileSync(`${path}.tmp`, raw, { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
    } catch {
      // Advisory history must not prevent launching the app; keep this process's baseline in memory.
    }
  });

  try {
    history.load(readFileSync(path, "utf8"));
  } catch {
    history.load(null);
  }

  const updated = history.observe(version);
  let announced = false;

  return () => {
    const result = { version, from: history.range?.from ?? "", updated: updated && !announced };
    announced = true;

    return result;
  };
}
