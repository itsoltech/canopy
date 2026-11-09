import { desktopIdentity } from "../src/identity.ts";

/** Only presentation changes. productName controls filenames and NSIS install paths. */
export function channelConfiguration(identity: ReturnType<typeof desktopIdentity>) {
  const icons = `../web/static/channels/${identity.channel}`;

  return {
    linux: {
      icon: `${icons}/icon-512.png`,
      desktop: { entry: { Name: identity.displayName, StartupWMClass: identity.productName } },
    },
    mac: {
      icon: `${icons}/icon.icns`,
      // CFBundleName also resolves Electron's helper executable names. Keep it stable.
      extendInfo: { CFBundleDisplayName: identity.displayName, CFBundleName: identity.productName },
    },
    win: { icon: `${icons}/icon.ico` },
    nsis: { shortcutName: identity.displayName, uninstallDisplayName: `${identity.displayName} \${version}` },
  };
}
