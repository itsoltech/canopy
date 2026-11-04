import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { desktopIdentity } from "../src/identity.ts";

const root = resolve(import.meta.dir, "..");

mkdirSync(resolve(root, "dist"), { recursive: true });

if (process.platform === "darwin") {
  const native = resolve(root, "build/native");
  mkdirSync(native, { recursive: true });
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
      "AppKit",
      "-I",
      resolve(dirname(require.resolve("node-api-headers/package.json")), "include"),
      resolve(root, "native/quit-key-event.mm"),
      "-o",
      resolve(native, "quit-key-event.node"),
    ],
    { stdio: "inherit" },
  );
}

for (const name of ["main", "preload"]) {
  const result = await Bun.build({
    entrypoints: [resolve(root, `src/${name}.ts`)],
    target: "node",
    format: "cjs",
    external: ["electron"],
    define: { CANOPY_DESKTOP_CHANNEL: JSON.stringify(desktopIdentity().channel) },
    naming: `${name}.cjs`,
    outdir: resolve(root, "dist"),
  });

  if (!result.success) throw new AggregateError(result.logs, "Electron shell build failed");
}

writeFileSync(resolve(root, "dist/identity.json"), JSON.stringify(desktopIdentity()));
