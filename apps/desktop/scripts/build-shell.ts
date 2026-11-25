import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { bunNotices, mergeNotices, type PackageNotice } from "../../../scripts/open-source-licenses.ts";
import { desktopIdentity } from "../src/identity.ts";
import { buildMacNativeAddon } from "./mac-native-addon.ts";

const root = resolve(import.meta.dir, "..");
const licenseOutput = process.env["CANOPY_SHELL_LICENSES"];
const notices: PackageNotice[][] = [];
const revision = process.env["CANOPY_REVISION"] ?? "";
const identity = desktopIdentity();

mkdirSync(resolve(root, "dist"), { recursive: true });

if (process.platform === "darwin") {
  const native = resolve(root, "build/native");

  for (const [name, framework] of [
    ["quit-key-event", "AppKit"],
    ["notification-permission", "UserNotifications"],
    ["activity-notch-display", "AppKit"],
  ] as const) {
    buildMacNativeAddon(native, name, framework);
  }
}

for (const name of [
  "main",
  "desktop-main",
  "html-viewer-process",
  "preload",
  "html-preload",
  "html-compile-worker",
  "activity-notch-preload",
]) {
  const result = await Bun.build({
    entrypoints: [resolve(root, `src/${name}.ts`)],
    metafile: !!licenseOutput,
    target: "node",
    format: "cjs",
    external: ["electron"],
    define: {
      CANOPY_DESKTOP_CHANNEL: JSON.stringify(identity.channel),
      CANOPY_DESKTOP_REVISION: JSON.stringify(revision),
    },
    naming: `${name}.cjs`,
    outdir: resolve(root, "dist"),
  });

  if (!result.success) throw new AggregateError(result.logs, "Electron shell build failed");

  if (licenseOutput) notices.push(bunNotices(result));
}

writeFileSync(resolve(root, "dist/identity.json"), JSON.stringify(identity));

if (licenseOutput) writeFileSync(licenseOutput, JSON.stringify(mergeNotices(...notices)));
