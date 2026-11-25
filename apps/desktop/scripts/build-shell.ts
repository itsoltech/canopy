import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { bunNotices, mergeNotices, type PackageNotice } from "../../../scripts/open-source-licenses.ts";
import { desktopIdentity } from "../src/identity.ts";

const root = resolve(import.meta.dir, "..");
const licenseOutput = process.env["CANOPY_SHELL_LICENSES"];
const notices: PackageNotice[][] = [];
const revision = process.env["CANOPY_REVISION"] ?? "";
const identity = desktopIdentity();

mkdirSync(resolve(root, "dist"), { recursive: true });

if (process.platform === "darwin") {
  const native = resolve(root, "build/native");
  mkdirSync(native, { recursive: true });

  for (const [name, framework] of [
    ["quit-key-event", "AppKit"],
    ["notification-permission", "UserNotifications"],
  ] as const) {
    execFileSync(
      "xcrun",
      [
        "clang++",
        "-bundle",
        "-undefined",
        "dynamic_lookup",
        "-fobjc-arc",
        "-DNAPI_VERSION=8",
        "-mmacosx-version-min=12.0",
        "-arch",
        process.arch === "arm64" ? "arm64" : "x86_64",
        "-framework",
        framework,
        "-I",
        resolve(dirname(require.resolve("node-api-headers/package.json")), "include"),
        resolve(root, `native/${name}.mm`),
        "-o",
        resolve(native, `${name}.node`),
      ],
      { stdio: "inherit" },
    );
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
