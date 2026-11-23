import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { desktopIdentity } from "../src/identity.ts";

/** Only presentation changes. productName controls filenames and NSIS install paths. */
export function channelConfiguration(identity: ReturnType<typeof desktopIdentity>) {
  const icons = `../web/static${identity.assets}`;
  const development = identity.channel === "development";
  const macIcon = development ? `${icons}/icon.icns` : `../../design/brand/apple/canopy-${identity.channel}.icon`;
  const source = resolve(import.meta.dir, "..", macIcon);
  const artwork = createHash("sha256");

  if (development) artwork.update(readFileSync(source));
  else {
    artwork.update(readFileSync(resolve(source, "icon.json")));

    for (const asset of readdirSync(resolve(source, "Assets")).sort()) {
      if (!asset.startsWith(".")) artwork.update(readFileSync(resolve(source, "Assets", asset)));
    }
  }

  return {
    linux: {
      icon: `${icons}/icon-512.png`,
      desktop: { entry: { Name: identity.displayName, StartupWMClass: identity.productName } },
    },
    mac: {
      icon: macIcon,
      extendInfo: {
        // Finder localizes the name only when this value matches the bundle's filesystem name.
        CFBundleDisplayName: identity.executableName,
        // Electron locates helper executables using the unlocalized CFBundleName.
        CFBundleName: identity.productName,
        CFBundleDevelopmentRegion: "en",
        CFBundleIconFile: `canopy-${artwork.digest("hex")}.icns`,
      },
    },
    win: { icon: `${icons}/icon.ico` },
    nsis: { shortcutName: identity.displayName, uninstallDisplayName: `${identity.displayName} \${version}` },
  };
}
