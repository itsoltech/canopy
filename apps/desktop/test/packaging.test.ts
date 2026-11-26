import { expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  lstatSync,
  readlinkSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tempDirs } from "@canopy/testing";
import { Arch } from "electron-builder";
import { noAgentClis } from "../../../scripts/agent-clis.ts";
import { desktopIdentity } from "../src/identity.ts";
import { channelConfiguration } from "../scripts/channel-configuration.ts";
import { generateAssetCatalogForIcon } from "app-builder-lib/out/util/macosIconComposer.js";
import { savePlistFile } from "app-builder-lib/out/util/plist.js";

const { createPackage } = require("@electron/asar") as { createPackage(source: string, output: string): Promise<void> };

interface PackageContext {
  arch: Arch;
  appOutDir: string;
  electronPlatformName: string;
  packager: {
    projectDir: string;
    appInfo?: { productFilename: string };
    platformSpecificBuildOptions?: { binaries: string[]; extendInfo: { CFBundleIconFile: string } };
  };
}

const verify = require("../scripts/verify-package.cjs") as (context: PackageContext) => Promise<void>;

const { packageMetrics } = require("../scripts/package-metrics.cjs") as {
  packageMetrics(app: string, resources: string, target: string): { target: string; total: number; budget: number };
};

const { restorePostgresLinks, linkDuplicateLibraries } = require("../scripts/postgres.cjs") as {
  restorePostgresLinks(directory: string): void;
  linkDuplicateLibraries(directory: string): void;
};

const { machOArchitectures, thinMachOFilesPortable } = require("../scripts/macho.cjs") as {
  machOArchitectures(path: string): string[];
  thinMachOFilesPortable(directory: string, arch: string): void;
};

const makeTemp = tempDirs();

const macArchitectures = ["arm64", "x64"] as const;

const machO = {
  arm64: Buffer.from("cffaedfe0c0000010000000061726d3634", "hex"),
  x64: Buffer.from("cffaedfe07000001000000007838363634", "hex"),
};

const generatedNotices = ["THIRD_PARTY_NOTICES.txt", "web/client/open-source-licenses.json"];

async function packed(extraAsarDependency = false, notices = generatedNotices, platform: "linux" | "win32" = "linux") {
  // The verifier also writes a size report next to appOutDir.
  const projectDir = makeTemp("canopy-package-guard-");
  const app = join(projectDir, "unpacked");
  const resources = join(app, "resources");
  const runtime = join(resources, "runtime");
  const preparedRuntime = join(projectDir, "build/runtime");
  const target = `${platform}-x64`;
  const sharp = `node_modules/@img/sharp-${target}/lib`;

  mkdirSync(join(preparedRuntime, "web/client"), { recursive: true });

  for (const path of notices) writeFileSync(join(preparedRuntime, path), "fixture");

  for (const path of [sharp, "node_modules/@anthropic-ai/claude-agent-sdk", "web/client/_app"])
    mkdirSync(join(runtime, path), { recursive: true });

  for (const path of [
    platform === "win32" ? "bun.exe" : "bun",
    "canopy-controller.js",
    "canopy-gateway.js",
    "canopy-worker.js",
    "canopy-web.js",
    ...notices,
    `${sharp}/sharp.node`,
    "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs",
  ])
    writeFileSync(join(runtime, path), "fixture");
  writeFileSync(join(runtime, "target.json"), JSON.stringify({ target }));
  writeFileSync(
    join(runtime, "postgres.json"),
    JSON.stringify({
      packageName: `@embedded-postgres/${target.replace("win32", "windows")}`,
      target,
      integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
    }),
  );
  const shell = makeTemp("canopy-asar-source-");
  mkdirSync(join(shell, "dist"));
  writeFileSync(join(shell, "dist/main.cjs"), "module.exports = {};");
  writeFileSync(join(shell, "dist/identity.json"), JSON.stringify(desktopIdentity("nightly")));
  writeFileSync(join(shell, "package.json"), JSON.stringify({ main: "dist/main.cjs" }));

  if (extraAsarDependency) {
    mkdirSync(join(shell, "node_modules/unexpected"), { recursive: true });
    writeFileSync(join(shell, "node_modules/unexpected/index.js"), "waste");
  }

  await createPackage(shell, join(resources, "app.asar"));

  return {
    app,
    resources,
    runtime,
    context: { arch: Arch.x64, appOutDir: app, electronPlatformName: platform, packager: { projectDir } },
  };
}

test("the final asar guard accepts a bundled shell and rejects app node_modules", async () => {
  await expect(verify((await packed()).context)).resolves.toBeUndefined();
  await expect(verify((await packed(true)).context)).rejects.toThrow("asar must not contain node_modules");
});

test("packaging verifies the notices supplied by the runtime revision", async () => {
  const historical = await packed(false, ["THIRD_PARTY_NOTICES.md"]);
  await expect(verify(historical.context)).resolves.toBeUndefined();
  unlinkSync(join(historical.runtime, "THIRD_PARTY_NOTICES.md"));
  await expect(verify(historical.context)).rejects.toThrow(
    "Packaged third-party notices missing: THIRD_PARTY_NOTICES.md",
  );

  const current = await packed();
  unlinkSync(join(current.runtime, "web/client/open-source-licenses.json"));
  await expect(verify(current.context)).rejects.toThrow(
    "Packaged third-party notices missing: web/client/open-source-licenses.json",
  );
});

test("packaging preserves the built sidebar icon and its compressed variants", async () => {
  const { context, runtime } = await packed(false, generatedNotices, "win32");
  const directory = "web/client/channels/nightly";
  const built = join(context.packager.projectDir, "build/runtime", directory);
  const packaged = join(runtime, directory);
  mkdirSync(built, { recursive: true });
  mkdirSync(packaged, { recursive: true });

  for (const asset of ["icon.svg", "icon.svg.br", "icon.svg.gz"]) {
    writeFileSync(join(built, asset), asset);
    copyFileSync(join(built, asset), join(packaged, asset));
  }

  await expect(verify(context)).resolves.toBeUndefined();

  // The old package copied the original artwork and dropped both generated files.
  for (const asset of ["icon.svg.br", "icon.svg.gz"]) {
    unlinkSync(join(packaged, asset));
    await expect(verify(context)).rejects.toThrow(`Packaged sidebar icon asset missing: ${directory}/${asset}`);
    copyFileSync(join(built, asset), join(packaged, asset));
  }

  writeFileSync(join(packaged, "icon.svg"), "different revision");
  await expect(verify(context)).rejects.toThrow("Packaged sidebar icon asset differs from the web build");
});

test("packaging rejects bundled agent CLIs and a bundled database", async () => {
  const first = await packed();
  writeFileSync(join(first.runtime, "node_modules/@anthropic-ai/claude-agent-sdk/claude"), "not allowed");
  await expect(verify(first.context)).rejects.toThrow("Agent CLI must not be packaged");
  const second = await packed();
  mkdirSync(join(second.runtime, "postgres"));
  await expect(verify(second.context)).rejects.toThrow("PostgreSQL must be downloaded only for local mode");
});

async function verifyMacPackaging(arch: "x64" | "arm64") {
  const fixture = await packed();
  const identity = desktopIdentity("nightly");
  const { mac } = channelConfiguration(identity);
  const artwork = join(import.meta.dir, "../../web/static", identity.assets);

  let catalog = null;

  if (process.platform === "darwin") {
    console.info("Compiling the Nightly icon with actool");
    catalog = await generateAssetCatalogForIcon(resolve(import.meta.dir, "..", mac.icon));
  }

  const icon =
    catalog?.icnsFile ?? readFileSync(resolve(import.meta.dir, "../../web/static/channels/development/icon.icns"));

  const application = join(fixture.app, "canopy.app");
  const resources = join(application, "Contents/Resources");
  mkdirSync(join(application, "Contents"), { recursive: true });
  renameSync(fixture.resources, resources);

  for (const locale of ["en", "pl"]) mkdirSync(join(resources, `${locale}.lproj`));
  writeFileSync(join(resources, "icon.icns"), icon);

  if (catalog) writeFileSync(join(resources, "Assets.car"), catalog.assetCatalog);
  copyFileSync(join(artwork, "icon-512.png"), join(resources, "icon.png"));
  mkdirSync(join(application, "Contents/MacOS"));
  writeFileSync(join(application, "Contents/MacOS/canopy"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await savePlistFile(join(application, "Contents/Info.plist"), {
    CFBundleExecutable: identity.executableName,
    CFBundleIdentifier: identity.appId,
    CFBundlePackageType: "APPL",
    CFBundleIconName: "Icon",
    ...mac.extendInfo,
  });
  const runtime = join(resources, "runtime");
  const target = `darwin-${arch}`;
  renameSync(join(runtime, "node_modules/@img/sharp-linux-x64"), join(runtime, `node_modules/@img/sharp-${target}`));
  writeFileSync(join(runtime, "target.json"), JSON.stringify({ target }));
  writeFileSync(
    join(runtime, "postgres.json"),
    JSON.stringify({
      packageName: `@embedded-postgres/${target}`,
      target,
      integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
    }),
  );
  const nativeBinary = machO[arch];
  const otherArch = arch === "arm64" ? "x64" : "arm64";
  writeFileSync(join(runtime, "bun"), nativeBinary);
  const signing = { binaries: [] as string[], extendInfo: mac.extendInfo };

  const context = {
    arch: Arch[arch],
    appOutDir: fixture.app,
    electronPlatformName: "darwin",
    packager: {
      ...fixture.context.packager,
      appInfo: { productFilename: "canopy" },
      platformSpecificBuildOptions: signing,
    },
  };

  await expect(verify({ ...context, arch: Arch[otherArch] })).rejects.toThrow(
    `Expected darwin-${otherArch} runtime, got ${target}`,
  );
  await expect(verify(context)).rejects.toThrow("Packaged native addon missing: quit-key-event.node");
  mkdirSync(join(resources, "native"));
  const adapter = join(resources, "native/quit-key-event.node");
  writeFileSync(adapter, machO[otherArch]);
  await expect(verify(context)).rejects.toThrow(`Native addon must be a ${arch} Mach-O: quit-key-event.node`);
  writeFileSync(adapter, nativeBinary);
  const permission = join(resources, "native/notification-permission.node");
  await expect(verify(context)).rejects.toThrow("Packaged native addon missing: notification-permission.node");
  writeFileSync(permission, nativeBinary);
  const display = join(resources, "native/activity-notch-display.node");
  await expect(verify(context)).rejects.toThrow("Packaged native addon missing: activity-notch-display.node");
  writeFileSync(display, machO[otherArch]);
  await expect(verify(context)).rejects.toThrow(`Native addon must be a ${arch} Mach-O: activity-notch-display.node`);
  writeFileSync(display, nativeBinary);
  writeFileSync(join(runtime, "bun"), machO[otherArch]);
  await expect(verify(context)).rejects.toThrow(`Packaged Mach-O must be ${arch} only`);
  writeFileSync(join(runtime, "bun"), nativeBinary);
  await expect(verify(context)).resolves.toBeUndefined();
  expect(signing.binaries).toContain(adapter);
  expect(signing.binaries).toContain(permission);
  expect(signing.binaries).toContain(display);

  for (const locale of ["en", "pl"]) {
    const localization = readFileSync(join(resources, `${locale}.lproj/InfoPlist.strings`), "utf8");
    expect(localization).toContain('"CFBundleDisplayName" = "Canopy (Nightly)";');
    expect(localization).toContain('"CFBundleName" = "Canopy (Nightly)";');
  }

  expect(readFileSync(join(resources, mac.extendInfo.CFBundleIconFile)).equals(icon)).toBe(true);

  if (process.platform === "darwin") {
    console.info("Checking the localized bundle name and artwork with Swift");

    const check = Bun.spawnSync([
      "swift",
      join(import.meta.dir, "../scripts/verify-macos-presentation.swift"),
      application,
      identity.displayName,
      artwork,
      "-AppleLanguages",
      "(pl)",
    ]);

    expect(check.exitCode, check.stderr.toString()).toBe(0);
  }
}

// On a hosted Intel runner, actool outlasted the previous three-minute test timeout.
const macPackagingTimeout = process.platform === "darwin" && process.arch === "x64" ? 300_000 : 60_000;

test.each(macArchitectures)(
  "macOS packaging signs the %s adapters and preserves localized identity",
  verifyMacPackaging,
  macPackagingTimeout,
);

test("the size guard rejects duplicated large files even outside node_modules", () => {
  const app = makeTemp("canopy-duplicate-binary-");
  const bytes = Buffer.alloc(8 * 1024 ** 2, 42);
  writeFileSync(join(app, "one"), bytes);
  writeFileSync(join(app, "two"), bytes);
  expect(() => packageMetrics(app, app, "linux-x64")).toThrow("Duplicate large packaged files");
});

test("standalone and Docker compiler plugins refuse a native SDK CLI import", async () => {
  const directory = makeTemp("canopy-no-cli-build-");
  const entry = join(directory, "worker.ts");
  writeFileSync(entry, 'import "@anthropic-ai/claude-agent-sdk-linux-x64";');
  const result = await Bun.build({ entrypoints: [entry], target: "bun", plugins: [noAgentClis], throw: false });
  expect(result.success).toBe(false);
  expect(result.logs.map((log) => log.message).join("\n")).toContain("never bundled");
});

test("Postgres aliases replace dereferenced copies, with relative links that survive moving the runtime", () => {
  const directory = makeTemp("canopy-postgres-alias-");
  mkdirSync(join(directory, "lib"));
  writeFileSync(join(directory, "lib/libicudata.77.1.dylib"), "icu");
  writeFileSync(join(directory, "lib/libicudata.dylib"), "icu");
  writeFileSync(
    join(directory, "pg-symlinks.json"),
    JSON.stringify([{ source: "native/lib/libicudata.77.1.dylib", target: "native/lib/libicudata.dylib" }]),
  );
  restorePostgresLinks(directory);
  expect(lstatSync(join(directory, "lib/libicudata.dylib")).isSymbolicLink()).toBe(true);
  expect(readlinkSync(join(directory, "lib/libicudata.dylib"))).toBe("libicudata.77.1.dylib");
  expect(readFileSync(join(directory, "lib/libicudata.dylib"), "utf8")).toBe("icu");
});

test("Postgres library copies without a manifest become links to the most specific name", () => {
  // The pinned 18.6 package ships an empty pg-symlinks.json and three 30 MB copies of each ICU library.
  const directory = makeTemp("canopy-postgres-dedupe-");
  mkdirSync(join(directory, "lib"));

  for (const name of [
    "libicudata.77.1.dylib",
    "libicudata.77.dylib",
    "libicudata.dylib",
    "libicuuc.so.77.1",
    "libicuuc.so.77",
  ])
    writeFileSync(join(directory, "lib", name), name.includes("icudata") ? "data" : "uc");
  writeFileSync(join(directory, "lib/libpq.5.dylib"), "pq5");
  writeFileSync(join(directory, "lib/libpq.dylib"), "different");
  linkDuplicateLibraries(directory);
  expect(readlinkSync(join(directory, "lib/libicudata.dylib"))).toBe("libicudata.77.1.dylib");
  expect(readlinkSync(join(directory, "lib/libicudata.77.dylib"))).toBe("libicudata.77.1.dylib");
  expect(lstatSync(join(directory, "lib/libicudata.77.1.dylib")).isFile()).toBe(true);
  expect(readlinkSync(join(directory, "lib/libicuuc.so.77"))).toBe("libicuuc.so.77.1");
  // Different contents are never linked.
  expect(lstatSync(join(directory, "lib/libpq.dylib")).isFile()).toBe(true);
});

test.each(macArchitectures)("PostgreSQL thinning selects the exact %s slice without lipo or Xcode", (arch) => {
  const directory = makeTemp("canopy-postgres-fat-macho-");
  const { arm64, x64 } = machO;
  const header = Buffer.alloc(48);
  header.writeUInt32BE(0xcafebabe, 0);
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(0x1000007, 8);
  header.writeUInt32BE(48, 16);
  header.writeUInt32BE(x64.length, 20);
  header.writeUInt32BE(0x100000c, 28);
  header.writeUInt32BE(48 + x64.length, 36);
  header.writeUInt32BE(arm64.length, 40);
  const binary = join(directory, "postgres");
  writeFileSync(binary, Buffer.concat([header, x64, arm64]), { mode: 0o755 });
  expect(machOArchitectures(binary)).toEqual(["x64", "arm64"]);
  thinMachOFilesPortable(directory, arch);
  expect(machOArchitectures(binary)).toEqual([arch]);
  expect(readFileSync(binary)).toEqual(machO[arch]);
  expect(lstatSync(binary).mode & 0o111).toBe(0o111);
});
