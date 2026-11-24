import { realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { instanceShadowHome, type AppliedConfig } from "../config/remote.ts";
import { directCodexHome, prepareCodexHome } from "../providers/codex/home.ts";
import { migrateLegacyCodexBotLogins, migrateLegacyCodexHardLinks } from "../providers/codex/legacy-login.ts";
import { isLegacyHardLink } from "../providers/home.ts";
import { providersOf } from "../providers/profiles.ts";

export function migrateCodexLogins(
  config: Pick<AppliedConfig, "profiles" | "codex">,
  dataDir: string,
  deviceHome: string,
  platform = process.platform,
): void {
  const sources = [deviceHome];
  const shadows = new Set<string>();
  const linkedShadows = new Map<string, string>();
  const linkLogin = config.codex.linkDeviceLogin;

  for (const { config: profile } of config.profiles) {
    if (!providersOf(profile).includes("codex")) continue;
    const runtime = profile.runtime;
    const configured = instanceShadowHome(dataDir, "codex", profile.id, runtime);
    const shadow = resolve(configured ?? join(dataDir, "codex-home"));
    const source = runtime?.homePath || deviceHome;

    if (runtime?.homePath) sources.push(runtime.homePath);

    if (runtime?.ownLogin) sources.push(shadow);
    else if (configured) shadows.add(shadow);

    if (
      !profile.disabled &&
      profile.kind === "native" &&
      linkLogin &&
      !runtime?.ownLogin &&
      !directCodexHome(profile, linkLogin, deviceHome)
    )
      linkedShadows.set(shadow, source);
  }

  migrateLegacyCodexBotLogins(dataDir, sources);

  if (platform !== "win32") return;
  migrateLegacyCodexHardLinks(dataDir, sources, [...shadows], (path, auth) => {
    const inDataDir = relative(realpathSync(dataDir), path);

    const source = linkedShadows.get(path) ?? linkedShadows.get(resolve(dataDir, inDataDir));

    if (!source || !isLegacyHardLink(auth, [resolve(source, "auth.json")])) return false;

    // Keep the legacy alias in place if either symbolic link cannot be installed.
    prepareCodexHome(
      { dataDir, path, deviceCodexHome: source, protectedDeviceHome: deviceHome, linkDeviceLogin: true },
      platform,
    );

    return true;
  });
}
