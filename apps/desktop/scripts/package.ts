import { resolve } from "node:path";
const desktop = resolve(import.meta.dir, "..");
if (!["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64"].includes(`${process.platform}-${process.arch}`)) throw new Error("Unsupported packaging host");
const args = process.platform === "linux" ? ["--linux", "AppImage", "deb"] : process.platform === "darwin" ? ["--mac", "dmg", "zip"] : ["--win", "nsis"];
// Release names follow the other assets (docs/release.md): Canopy-<version>-<linux|darwin|windows>-<x64|arm64>.<ext>,
// instead of electron-builder's per-format arch names (x86_64, amd64) and mac/win.
const os = process.platform === "win32" ? "windows" : process.platform;
const config = [`-c.artifactName=Canopy-\${version}-${os}-${process.arch}.\${ext}`];
// The one Canopy version (scripts/version.ts) when the release pipeline sets it; package.json's otherwise.
const version = process.env["CANOPY_VERSION"];
if (version) config.push(`-c.extraMetadata.version=${version}`);
const builder = resolve(require.resolve("electron-builder"), "../cli/cli.js");
const child = Bun.spawn(["node", builder, ...args, `--${process.arch}`, ...config, "--publish", "never"], { cwd: desktop, stdio: ["inherit", "inherit", "inherit"] });
process.exit(await child.exited);
