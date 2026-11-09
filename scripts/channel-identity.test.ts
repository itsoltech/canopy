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
import { mobileScene, treeGeometry } from "./icons/mobile.ts";

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
    expect(config.android?.adaptiveIcon?.backgroundImage).toBe(
      `../web/static/channels/${channel}/adaptive-background.png`,
    );
    expect(config.android?.adaptiveIcon?.monochromeImage).toBe(
      `../web/static/channels/${channel}/adaptive-monochrome.png`,
    );
    expect(config.plugins).toContainEqual([
      "expo-splash-screen",
      expect.objectContaining({
        image: `../web/static/channels/${channel}/splash.png`,
        backgroundColor: releaseIdentity(channel).background,
        dark: expect.objectContaining({
          image: `../web/static/channels/${channel}/splash.png`,
          backgroundColor: releaseIdentity(channel).background,
        }),
      }),
    ]);
  }
}, 30_000);

test("native channel artwork is full-bleed on iOS and gives Android launcher masks breathing room", async () => {
  for (const channel of ["stable", "beta", "nightly"] as const) {
    const directory = join(root, "apps/web/static/channels", channel);
    const icon = sharp(join(directory, "expo-icon.png"));
    const metadata = await icon.metadata();
    expect([metadata.width, metadata.height, metadata.channels, metadata.hasAlpha]).toEqual([1024, 1024, 3, false]);
    expect((await icon.stats()).isOpaque).toBe(true);

    const actual = await icon.raw().toBuffer();
    const scene = await sharp(mobileScene(channel)).removeAlpha().raw().toBuffer();
    const matte = Buffer.alloc(1024 * 1024 * 4);

    for (let i = 0; i < 1024 * 1024; i++) {
      const difference = Math.max(...[0, 1, 2].map((c) => Math.abs(actual[i * 3 + c]! - scene[i * 3 + c]!)));
      matte[i * 4 + 3] = difference > 3 ? 255 : 0;
    }

    const bounds = await treeGeometry(
      await sharp(matte, { raw: { width: 1024, height: 1024, channels: 4 } })
        .png()
        .toBuffer(),
    );

    // A desktop tile at half size cannot meet this silhouette size/placement.
    expect(bounds.width / 1024).toBeGreaterThanOrEqual(0.68);
    expect(bounds.width / 1024).toBeLessThanOrEqual(0.75);
    expect((bounds.left + bounds.width / 2) / 1024).toBeCloseTo(0.5, 2);
    expect((bounds.top + bounds.height / 2) / 1024).toBeCloseTo(0.48, 2);

    // The scene reaches every edge: there is no pre-drawn rounded mask or tile.
    for (const [x, y] of [
      [0, 0],
      [1023, 0],
      [0, 1023],
      [1023, 1023],
      [512, 0],
      [0, 512],
    ]) {
      const offset = (y! * 1024 + x!) * 3;
      expect(actual.subarray(offset, offset + 3)).toEqual(scene.subarray(offset, offset + 3));
    }

    const foreground = join(directory, "adaptive-foreground.png");
    const alpha = await sharp(foreground).extractChannel("alpha").raw().toBuffer();
    let radius = 0;

    for (let y = 0; y < 1024; y++)
      for (let x = 0; x < 1024; x++)
        if (alpha[y * 1024 + x]) radius = Math.max(radius, Math.hypot(x - 511.5, y - 511.5));
    // The visible mask spans 72 dp of the 108 dp canvas. The circle is the
    // tightest mask; squircle and rounded-square both enclose that circle.
    const visibleDiameter = (1024 * 72) / 108;
    const clearance = (visibleDiameter / 2 - radius) / visibleDiameter;
    expect(clearance).toBeGreaterThanOrEqual(0.08);
    expect(clearance).toBeLessThan(0.12);
    // Moon/sun stays entirely clear of the tree and inside the circle launcher.
    let moonCoverage = 0;
    let moonRadius = 0;

    for (let y = 244; y <= 288; y++)
      for (let x = 682; x <= 726; x++) {
        if (Math.hypot(x - 704, y - 266) > 22) continue;
        moonCoverage += alpha[y * 1024 + x]!;
        moonRadius = Math.max(moonRadius, Math.hypot(x - 512, y - 512));
      }

    expect(moonCoverage).toBe(0);
    expect(moonRadius).toBeLessThan(1024 / 3);
    expect(await sharp(join(directory, "adaptive-monochrome.png")).extractChannel("alpha").raw().toBuffer()).toEqual(
      alpha,
    );
    expect((await sharp(join(directory, "adaptive-background.png")).metadata()).hasAlpha).toBe(false);
    const splash = await treeGeometry(readFileSync(join(directory, "splash.png")));
    expect(Math.max(splash.width, splash.height)).toBeGreaterThan(500);
  }
});
