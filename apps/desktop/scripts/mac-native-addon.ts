import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function buildMacNativeAddon(outputDirectory: string, name: string, framework: string) {
  mkdirSync(outputDirectory, { recursive: true });
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
      resolve(import.meta.dir, `../native/${name}.mm`),
      "-o",
      resolve(outputDirectory, `${name}.node`),
    ],
    { stdio: "inherit" },
  );
}
