import { realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { Provider } from "@canopy/contracts";
import { botSessionInstanceKey } from "../bots/session.ts";
import { instanceShadowHome, type AppliedConfig } from "../config/remote.ts";
import { directCodexHome, prepareCodexHome } from "../providers/codex/home.ts";
import { migrateLegacyCodexHardLinks } from "../providers/codex/legacy-login.ts";
import { isLegacyHardLink } from "../providers/home.ts";
import { providersOf } from "../providers/profiles.ts";

export function migrateCodexLogins(
  config: Pick<AppliedConfig, "profiles" | "codex">,
  dataDir: string,
  deviceHome: string,
  platform = process.platform,
): void {
  if (platform !== "win32") return;
  const sources = [deviceHome];
  const shadows = new Set<string>();
  const linkedShadows = new Map<string, string>();
  const linkedBots = new Map<string, string>();
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

    if (profile.disabled || profile.kind !== "native") continue;

    if (linkLogin && !runtime?.ownLogin && !directCodexHome(profile, linkLogin, deviceHome))
      linkedShadows.set(shadow, source);

    if (linkLogin || runtime?.ownLogin)
      linkedBots.set(botSessionInstanceKey(Provider.CODEX, profile.id), runtime?.ownLogin ? shadow : source);
  }

  migrateLegacyCodexHardLinks(dataDir, sources, [...shadows], (path, auth) => {
    const inDataDir = relative(realpathSync(dataDir), path);

    const source =
      linkedShadows.get(path) ??
      linkedShadows.get(resolve(dataDir, inDataDir)) ??
      botLoginSource(inDataDir, linkedBots);

    if (!source || !isLegacyHardLink(auth, [resolve(source, "auth.json")])) return false;

    // Keep the legacy alias in place if either symbolic link cannot be installed.
    prepareCodexHome(
      { dataDir, path, deviceCodexHome: source, protectedDeviceHome: deviceHome, linkDeviceLogin: true },
      platform,
    );

    return true;
  });
}

function botLoginSource(path: string, sources: ReadonlyMap<string, string>): string | undefined {
  const parts = path.split(sep);

  if (parts[0] !== "bots" || parts.at(-1) !== "home") return undefined;

  if (parts.length === 4 || (parts.length === 6 && parts[2] === "conversations"))
    return sources.get(parts.at(-2) ?? "");

  return undefined;
}
