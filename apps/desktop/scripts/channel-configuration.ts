import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { desktopIdentity } from "../src/identity.ts";

/** Only presentation changes. productName controls filenames and NSIS install paths. */
export function channelConfiguration(identity: ReturnType<typeof desktopIdentity>) {
  const icons = `../web/static${identity.assets}`;
  const macIcon = `${icons}/icon.icns`;

  const artworkHash = createHash("sha256")
    .update(readFileSync(resolve(import.meta.dir, "..", macIcon)))
    .digest("hex");

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
        CFBundleIconFile: `canopy-${artworkHash}.icns`,
      },
    },
    win: { icon: `${icons}/icon.ico` },
    nsis: { shortcutName: identity.displayName, uninstallDisplayName: `${identity.displayName} \${version}` },
  };
}
