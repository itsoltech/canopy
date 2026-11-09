import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AppInfo } from "app-builder-lib/out/appInfo.js";
import { Packager } from "app-builder-lib/out/packager.js";
import { getWindowsInstallationDirName } from "app-builder-lib/out/targets/targetUtil.js";
import type { ExpoConfig } from "expo/config";
import sharp from "sharp";
import { desktopIdentity, desktopUserData } from "../apps/desktop/src/identity.ts";
import { channelConfiguration } from "../apps/desktop/scripts/channel-configuration.ts";
import desktop from "../apps/desktop/package.json";
import eas from "../apps/mobile/eas.json";
import { releaseIdentity } from "@canopy/domain/release/identity";

const root = resolve(import.meta.dir, "..");
const desktopDirectory = join(root, "apps/desktop");
const names = { stable: "Canopy", beta: "Canopy (Beta)", nightly: "Canopy (Nightly)" };

test("channel presentation preserves Electron installation, crypto, data and updater identities", async () => {
  for (const channel of ["stable", "beta", "nightly"] as const) {
    const identity = desktopIdentity(channel);
    const presentation = channelConfiguration(identity);
    const configuration = { ...desktop.build, ...presentation };

    const packager = new (class extends Packager {
      override get config() {
        return {
          appId: identity.appId,
          productName: identity.productName,
          executableName: identity.executableName,
          ...presentation,
        };
      }

      override get metadata() {
        return { name: identity.executableName, version: desktop.version };
      }
    })({ projectDir: desktopDirectory });

    const info = new AppInfo(packager, undefined);

    expect(identity.displayName).toBe(names[channel]);
    expect(info.productName).toBe("Canopy");
    expect(info.productFilename).toBe("canopy");
    expect(info.macBundleIdentifier).toBe("app.canopy.desktop");
    expect(info.id).toBe("app.canopy.desktop");
    expect(info.updaterCacheDirName).toBe("canopy-updater");
    expect(getWindowsInstallationDirName(info, true)).toBe("canopy");
    expect(desktopUserData("app-data")).toBe(join("app-data", "Canopy"));
    expect(configuration.protocols[0]?.schemes).toEqual([identity.scheme]);
    expect(identity.scheme).toBe("canopy");
    expect(identity.artifactPrefix).toBe("Canopy");
    expect(presentation.mac.extendInfo).toEqual({ CFBundleName: "Canopy", CFBundleDisplayName: names[channel] });
    expect(presentation.linux.desktop.entry).toEqual({ Name: names[channel], StartupWMClass: "Canopy" });
    expect(presentation.nsis.shortcutName).toBe(names[channel]);
    expect(presentation.nsis.uninstallDisplayName).toBe(`${names[channel]} \${version}`);

    for (const icon of [presentation.linux.icon, presentation.mac.icon, presentation.win.icon])
      expect(existsSync(resolve(desktopDirectory, icon))).toBe(true);

    const iconDirectory = join(root, "apps/web/static/channels", channel);
    const png = readFileSync(join(iconDirectory, "icon-512.png"));
    const metadata = await sharp(png).metadata();
    expect([metadata.width, metadata.height]).toEqual([512, 512]);
    expect(readFileSync(join(iconDirectory, "icon.icns")).subarray(0, 4).toString()).toBe("icns");
    expect(readFileSync(join(iconDirectory, "icon.ico")).readUInt16LE(2)).toBe(1);

    if (channel === "stable") expect(png).toEqual(readFileSync(join(root, "apps/web/static/icon-512.png")));
  }

  // Protect the actual bootstrap, including the crypto name, against accidental use of displayName.
  const bootstrap = readFileSync(join(desktopDirectory, "src/main.ts"), "utf8");
  expect(bootstrap).toContain("app.setName(identity.productName)");
  expect(bootstrap).toContain('app.setPath("userData", desktopUserData(app.getPath("appData")))');
});

test("EAS profiles resolve actual Expo config with channel assets and unchanged native identifiers", () => {
  for (const profile of [
    "production",
    "production-beta",
    "production-stable",
    "preview",
    "preview-beta",
    "preview-stable",
  ] as const) {
    const { channel } = releaseIdentity(eas.build[profile].env.CANOPY_CHANNEL);

    const result = Bun.spawnSync(
      [process.execPath, join(root, "node_modules/expo/bin/cli"), "config", "--type", "public", "--json"],
      {
        cwd: join(root, "apps/mobile"),
        env: { ...process.env, CANOPY_CHANNEL: "", EAS_BUILD_PROFILE: profile },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const config: ExpoConfig = JSON.parse(result.stdout.toString());
    expect(config.name).toBe(names[channel]);
    expect(config.icon).toBe(`../web/static/channels/${channel}/expo-icon.png`);
    expect(config.ios?.bundleIdentifier).toBe("tech.itsol.canopy-remote");
    expect(config.android?.package).toBe("tech.itsol.canopy_remote");
    expect(config.scheme).toBe("canopy");
    const foreground = config.android?.adaptiveIcon?.foregroundImage;
    expect(foreground).toBe(`../web/static/channels/${channel}/adaptive-foreground.png`);
    expect(existsSync(resolve(root, "apps/mobile", config.icon!))).toBe(true);
    expect(existsSync(resolve(root, "apps/mobile", foreground!))).toBe(true);
    expect(config.plugins).toContainEqual([
      "expo-splash-screen",
      expect.objectContaining({ image: `../web/static/channels/${channel}/icon-512.png` }),
    ]);
  }
}, 30_000);
