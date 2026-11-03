import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync, lstatSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "@canopy/testing";
import { noAgentClis } from "../../../scripts/agent-clis.ts";

const { createPackage } = require("@electron/asar") as { createPackage(source: string, output: string): Promise<void> };
const verify = require("../scripts/verify-package.cjs") as (context: unknown) => Promise<void>;
const { packageMetrics } = require("../scripts/package-metrics.cjs") as { packageMetrics(app: string, resources: string, target: string): unknown };
const { restorePostgresLinks } = require("../scripts/postgres.cjs") as { restorePostgresLinks(directory: string): void };
const { machOArchitectures, thinMachOFilesPortable } = require("../scripts/macho.cjs") as { machOArchitectures(path: string): string[]; thinMachOFilesPortable(directory: string, arch: string): void };
const makeTemp = tempDirs();

async function packed(extraAsarDependency = false) {
  // The verifier also writes a size report next to appOutDir.
  const app = join(makeTemp("canopy-package-guard-"), "unpacked");
  const resources = join(app, "resources");
  const runtime = join(resources, "runtime");
  for (const path of ["node_modules/@img/sharp-linux-x64/lib", "node_modules/@anthropic-ai/claude-agent-sdk", "web/client/_app"]) mkdirSync(join(runtime, path), { recursive: true });
  for (const path of ["bun", "canopy-controller.js", "canopy-gateway.js", "canopy-worker.js", "canopy-web.js", "node_modules/@img/sharp-linux-x64/lib/sharp.node", "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs"]) writeFileSync(join(runtime, path), "fixture");
  writeFileSync(join(runtime, "target.json"), JSON.stringify({ target: "linux-x64" }));
  writeFileSync(join(runtime, "postgres.json"), JSON.stringify({ packageName: "@embedded-postgres/linux-x64", target: "linux-x64", integrity: `sha512-${Buffer.alloc(64).toString("base64")}` }));
  const shell = makeTemp("canopy-asar-source-");
  mkdirSync(join(shell, "dist"));
  writeFileSync(join(shell, "dist/main.cjs"), "module.exports = {};");
  writeFileSync(join(shell, "package.json"), JSON.stringify({ main: "dist/main.cjs" }));
  if (extraAsarDependency) { mkdirSync(join(shell, "node_modules/unexpected"), { recursive: true }); writeFileSync(join(shell, "node_modules/unexpected/index.js"), "waste"); }
  await createPackage(shell, join(resources, "app.asar"));
  return { app, resources, runtime, context: { appOutDir: app, electronPlatformName: "linux", packager: {} } };
}

test("the final asar guard accepts a bundled shell and rejects app node_modules", async () => {
  await expect(verify((await packed()).context)).resolves.toBeUndefined();
  await expect(verify((await packed(true)).context)).rejects.toThrow("asar must not contain node_modules");
});

test("packaging rejects bundled agent CLIs and a bundled database", async () => {
  const first = await packed();
  writeFileSync(join(first.runtime, "node_modules/@anthropic-ai/claude-agent-sdk/claude"), "not allowed");
  await expect(verify(first.context)).rejects.toThrow("Agent CLI must not be packaged");
  const second = await packed();
  mkdirSync(join(second.runtime, "postgres"));
  await expect(verify(second.context)).rejects.toThrow("PostgreSQL must be downloaded only for local mode");
});

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
  writeFileSync(join(directory, "pg-symlinks.json"), JSON.stringify([{ source: "native/lib/libicudata.77.1.dylib", target: "native/lib/libicudata.dylib" }]));
  restorePostgresLinks(directory);
  expect(lstatSync(join(directory, "lib/libicudata.dylib")).isSymbolicLink()).toBe(true);
  expect(readlinkSync(join(directory, "lib/libicudata.dylib"))).toBe("libicudata.77.1.dylib");
  expect(readFileSync(join(directory, "lib/libicudata.dylib"), "utf8")).toBe("icu");
});

test("macOS runtime thinning selects the exact arm64 slice without lipo or Xcode", () => {
  const directory = makeTemp("canopy-postgres-fat-macho-");
  const arm64 = Buffer.from("cffaedfe0c0000010000000061726d3634", "hex");
  const x64 = Buffer.from("cffaedfe07000001000000007838363634", "hex");
  const header = Buffer.alloc(48);
  header.writeUInt32BE(0xcafebabe, 0); header.writeUInt32BE(2, 4);
  header.writeUInt32BE(0x1000007, 8); header.writeUInt32BE(48, 16); header.writeUInt32BE(x64.length, 20);
  header.writeUInt32BE(0x100000c, 28); header.writeUInt32BE(48 + x64.length, 36); header.writeUInt32BE(arm64.length, 40);
  const binary = join(directory, "postgres");
  writeFileSync(binary, Buffer.concat([header, x64, arm64]), { mode: 0o755 });
  expect(machOArchitectures(binary)).toEqual(["x64", "arm64"]);
  thinMachOFilesPortable(directory, "arm64");
  expect(machOArchitectures(binary)).toEqual(["arm64"]);
  expect(readFileSync(binary)).toEqual(arm64);
  expect(lstatSync(binary).mode & 0o111).toBe(0o111);
});
