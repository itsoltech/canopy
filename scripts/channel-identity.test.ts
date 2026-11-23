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
import { appIdentity, releaseIdentity } from "@canopy/domain/release/identity";

const root = resolve(import.meta.dir, "..");
const desktopDirectory = join(root, "apps/desktop");
const channels = ["stable", "beta", "nightly", "development"] as const;
const names = { stable: "Canopy", beta: "Canopy (Beta)", nightly: "Canopy (Nightly)", development: "Canopy" };

test("channel presentation preserves Electron installation, crypto, data and updater identities", async () => {
  for (const channel of channels) {
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
    expect(identity.channel).toBe(channel);
    expect(identity.updateChannel).toBe(channel === "development" ? "stable" : channel);
    expect(identity.feed).toBe(identity.updateChannel === "stable" ? "latest" : identity.updateChannel);
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
    expect(presentation.mac.extendInfo.CFBundleName).toBe("Canopy");
    expect(presentation.mac.extendInfo.CFBundleDisplayName).toBe(info.productFilename);
    expect(presentation.mac.extendInfo.CFBundleIconFile).toMatch(/^canopy-[a-f0-9]{64}\.icns$/);
    expect(presentation.linux.desktop.entry).toEqual({ Name: names[channel], StartupWMClass: "Canopy" });
    expect(presentation.nsis.shortcutName).toBe(names[channel]);
    expect(presentation.nsis.uninstallDisplayName).toBe(`${names[channel]} \${version}`);

    for (const icon of [presentation.linux.icon, presentation.win.icon]) {
      expect(icon).toStartWith(`../web/static/channels/${channel}/`);
      expect(existsSync(resolve(desktopDirectory, icon))).toBe(true);
    }

    const iconDirectory = join(root, "apps/web/static/channels", channel);
    const master = channel === "development" ? "dev" : channel;
    const macIcon = resolve(desktopDirectory, presentation.mac.icon);

    if (channel === "development") {
      expect(macIcon).toBe(join(iconDirectory, "icon.icns"));
    } else {
      expect(macIcon).toBe(join(root, `design/brand/apple/canopy-${channel}.icon`));
      const artwork = readFileSync(join(macIcon, `Assets/${channel}.svg`), "utf8");
      expect(artwork).toBe(
        readFileSync(join(iconDirectory, "icon.svg"), "utf8").replace(
          'width="128" height="128" viewBox',
          'width="1024" height="1024" viewBox',
        ),
      );
    }

    expect(readFileSync(join(iconDirectory, "icon.svg"), "utf8")).toBe(
      readFileSync(join(root, `design/brand/app-icons/canopy-${master}.svg`), "utf8"),
    );
    const png = readFileSync(join(iconDirectory, "icon-512.png"));
    const metadata = await sharp(png).metadata();
    expect([metadata.width, metadata.height]).toEqual([512, 512]);
    expect(readFileSync(join(iconDirectory, "icon.ico")).readUInt16LE(2)).toBe(1);

    if (channel === "stable") expect(png).toEqual(readFileSync(join(root, "apps/web/static/icon-512.png")));
  }

  expect(() => releaseIdentity("development")).toThrow("Invalid release channel");

  // Protect the actual bootstrap, including the crypto name, against accidental use of displayName.
  const bootstrap = readFileSync(join(desktopDirectory, "src/desktop-main.ts"), "utf8");
  expect(bootstrap).toContain("app.setName(identity.productName)");
  expect(bootstrap).toContain('app.setPath("userData", desktopUserData(app.getPath("appData")))');
});

function icnsEntries(file: Buffer) {
  expect(file.toString("ascii", 0, 4)).toBe("icns");
  expect(file.readUInt32BE(4)).toBe(file.length);
  const entries = new Map<string, Buffer>();

  for (let offset = 8; offset < file.length;) {
    const type = file.toString("ascii", offset, offset + 4);
    const length = file.readUInt32BE(offset + 4);
    expect(length).toBeGreaterThan(8);
    expect(offset + length).toBeLessThanOrEqual(file.length);
    expect(entries.has(type)).toBe(false);
    entries.set(type, file.subarray(offset + 8, offset + length));
    offset += length;
  }

  return entries;
}

function unpackIcnsRgb(data: Buffer, pixelCount: number) {
  const planes = Buffer.alloc(pixelCount * 3);
  let written = 0;

  for (let offset = 0; offset < data.length;) {
    const control = data.readUInt8(offset++);
    const count = control < 128 ? control + 1 : control - 125;
    expect(count).toBeLessThanOrEqual(pixelCount - (written % pixelCount));

    if (control < 128) {
      expect(data.copy(planes, written, offset, offset + count)).toBe(count);
      offset += count;
    } else {
      planes.fill(data.readUInt8(offset++), written, written + count);
    }

    written += count;
  }

  expect(written).toBe(planes.length);

  return planes;
}

test("the Dev ICNS preserves the artwork in bundle-safe small icon representations", async () => {
  const directory = join(root, "apps/web/static/channels/development");
  const entries = icnsEntries(readFileSync(join(directory, "icon.icns")));

  for (const type of ["icp4", "icp5", "icp6"]) expect(entries.has(type)).toBe(false);

  for (const [rgbType, maskType, size] of [
    ["is32", "s8mk", 16],
    ["il32", "l8mk", 32],
  ] as const) {
    const rgba = await sharp(join(directory, `icon-${size}.png`))
      .ensureAlpha()
      .raw()
      .toBuffer();

    const pixelCount = size * size;
    const planes = unpackIcnsRgb(entries.get(rgbType)!, pixelCount);
    const channels = [0, 1, 2, 3].map((index) => rgba.filter((_, offset) => offset % 4 === index));
    expect(planes.equals(Buffer.concat(channels.slice(0, 3)))).toBe(true);
    expect(entries.get(maskType)?.equals(channels[3]!)).toBe(true);
  }

  for (const [type, size] of [
    ["ic11", 32],
    ["ic12", 64],
  ] as const) {
    expect(entries.get(type)?.equals(readFileSync(join(directory, `icon-${size}.png`)))).toBe(true);
  }
});

test("EAS profiles resolve actual Expo config with channel assets and unchanged native identifiers", () => {
  for (const profile of [
    "development",
    "development-simulator",
    "production",
    "production-beta",
    "production-stable",
    "preview",
    "preview-beta",
    "preview-stable",
  ] as const) {
    const channel =
      profile === "development" || profile === "development-simulator"
        ? "development"
        : releaseIdentity(eas.build[profile].env.CANOPY_CHANNEL).channel;

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
    expect(config.extra?.["canopyChannel"]).toBe(channel);
    expect(config.icon).toBe(`../web/static/channels/${channel}/expo-icon.png`);
    expect(config.ios?.icon).toBe(
      channel === "development" ? undefined : `../../design/brand/apple/canopy-${channel}.icon`,
    );
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
        backgroundColor: appIdentity(channel).background,
        dark: expect.objectContaining({
          image: `../web/static/channels/${channel}/splash.png`,
          backgroundColor: appIdentity(channel).background,
        }),
      }),
    ]);
  }
}, 30_000);

test("iOS and Apple touch icons carry the approved artwork to the edge of the system mask", async () => {
  for (const channel of channels) {
    const directory = join(root, "apps/web/static/channels", channel);
    const background = Buffer.from(appIdentity(channel).background.slice(1), "hex");
    const icon = sharp(join(directory, "expo-icon.png"));
    const metadata = await icon.metadata();
    expect([metadata.width, metadata.height, metadata.channels, metadata.hasAlpha]).toEqual([1024, 1024, 3, false]);

    const actual = await icon.raw().toBuffer();
    const reference = await sharp(join(directory, "icon.svg"), { density: 576 }).ensureAlpha().raw().toBuffer();
    let mismatches = 0;

    for (let pixel = 0; pixel < 1024 * 1024; pixel++) {
      // Compare the painted desktop tile. Its outside corners are supplied by the native launcher.
      if (reference[pixel * 4 + 3] !== 255) continue;
      const rgb = pixel * 3;
      const rgba = pixel * 4;

      if (
        Math.abs(actual[rgb]! - reference[rgba]!) > 3 ||
        Math.abs(actual[rgb + 1]! - reference[rgba + 1]!) > 3 ||
        Math.abs(actual[rgb + 2]! - reference[rgba + 2]!) > 3
      )
        mismatches++;
    }

    expect(mismatches).toBeLessThan(1024); // Allow subpixel rasterization differences along curves.

    for (const pixel of [0, 1023, 1023 * 1024, 1024 * 1024 - 1])
      expect(actual.subarray(pixel * 3, pixel * 3 + 3)).toEqual(background);

    const touch = await sharp(join(directory, "icon-180.png")).metadata();
    expect([touch.width, touch.height, touch.channels, touch.hasAlpha]).toEqual([180, 180, 3, false]);
  }
});

test("Android keeps the branded foreground inside its safe zone in both full color and themed launchers", async () => {
  for (const channel of channels) {
    const directory = join(root, "apps/web/static/channels", channel);
    const foreground = sharp(join(directory, "adaptive-foreground.png"));
    const { data: alpha, info } = await foreground.extractChannel("alpha").raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([1024, 1024]);
    let radius = 0;

    for (let y = 0; y < 1024; y++)
      for (let x = 0; x < 1024; x++)
        if (alpha[y * 1024 + x]) radius = Math.max(radius, Math.hypot(x - 511.5, y - 511.5));

    // All foreground ink, including the Dev ruler and Nightly moon, fits the 66 dp safe circle on a 108 dp canvas.
    expect(radius).toBeLessThanOrEqual((1024 * 33) / 108);
    expect(alpha[432 * 1024 + 512]).toBe(255); // Solid center of the crown.
    const mono = await sharp(join(directory, "adaptive-monochrome.png")).extractChannel("alpha").raw().toBuffer();
    expect(mono.equals(alpha)).toBe(true);
    expect((await sharp(join(directory, "adaptive-background.png")).metadata()).hasAlpha).toBe(false);
    const splash = sharp(join(directory, "splash.png"));
    expect((await splash.metadata()).hasAlpha).toBe(true);
    const { info: bounds } = await splash.trim().png().toBuffer({ resolveWithObject: true });
    expect(Math.max(bounds.width, bounds.height)).toBeGreaterThan(400);
  }
});
