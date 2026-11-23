import { instanceShadowHome, type AppliedConfig } from "../config/remote.ts";
import { removeLegacyCodexHardLinks } from "../providers/codex/legacy-login.ts";
import { providersOf } from "../providers/profiles.ts";

export function migrateCodexLogins(config: AppliedConfig, dataDir: string, deviceHome: string): void {
  if (process.platform !== "win32") return;
  const sources = [deviceHome];
  const shadows: string[] = [];

  for (const { config: profile } of config.profiles) {
    if (!providersOf(profile).includes("codex")) continue;
    const runtime = profile.runtime;
    const shadow = instanceShadowHome(dataDir, "codex", profile.id, runtime);

    if (runtime?.homePath) sources.push(runtime.homePath);

    if (shadow) (runtime?.ownLogin ? sources : shadows).push(shadow);
  }

  removeLegacyCodexHardLinks(dataDir, sources, shadows);
}
