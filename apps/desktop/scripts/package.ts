import { resolve } from "node:path";
const desktop = resolve(import.meta.dir, "..");
if (!["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64"].includes(`${process.platform}-${process.arch}`)) throw new Error("Unsupported packaging host");
const args = process.platform === "linux" ? ["--linux", "AppImage", "deb"] : process.platform === "darwin" ? ["--mac", "dmg"] : ["--win", "nsis"];
const builder = resolve(require.resolve("electron-builder"), "../cli/cli.js");
const child = Bun.spawn(["node", builder, ...args, `--${process.arch}`, "--publish", "never"], { cwd: desktop, stdio: ["inherit", "inherit", "inherit"] });
process.exit(await child.exited);
