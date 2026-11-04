const { existsSync, readFileSync, readdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { listPackage } = require("@electron/asar");
const { packageMetrics } = require("./package-metrics.cjs");

// Validate the final resources, not the build directory. electron-builder deliberately
// filters a root node_modules directory unless it has its own resource mapping.
module.exports = async ({ appOutDir, electronPlatformName, packager }) => {
  const resources =
    electronPlatformName === "darwin"
      ? join(appOutDir, `${packager.appInfo.productFilename}.app/Contents/Resources`)
      : join(appOutDir, "resources");

  const application = electronPlatformName === "darwin" ? join(resources, "../..") : appOutDir;
  const runtime = join(resources, "runtime");
  const archive = join(resources, "app.asar");

  if (listPackage(archive).some((path) => /[/\\]node_modules(?:[/\\]|$)/.test(path)))
    throw new Error("App asar must not contain node_modules; bundle the shell dependencies");

  if (existsSync(archive + ".unpacked"))
    throw new Error("Unexpected app.asar.unpacked: the shell must be fully bundled");
  const { target } = JSON.parse(readFileSync(join(runtime, "target.json"), "utf8"));
  const suffix = electronPlatformName === "win32" ? ".exe" : "";

  if (!existsSync(join(runtime, "bun" + suffix))) throw new Error("Packaged Bun missing");

  for (const name of ["controller", "gateway", "worker", "web"]) {
    if (!existsSync(join(runtime, `canopy-${name}.js`))) throw new Error(`Packaged sidecar missing: ${name}`);
  }

  if (existsSync(join(runtime, "postgres")))
    throw new Error("PostgreSQL must be downloaded only for local mode, never packaged");
  const pin = JSON.parse(readFileSync(join(runtime, "postgres.json"), "utf8"));

  if (
    pin.target !== target ||
    pin.packageName !== `@embedded-postgres/${target.replace("win32", "windows")}` ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/.test(pin.integrity)
  )
    throw new Error("Invalid packaged PostgreSQL pin");

  const allowed = new Set([
    "@anthropic-ai/claude-agent-sdk",
    `@img/sharp-${target}`,
    ...(electronPlatformName === "win32" ? [] : [`@img/sharp-libvips-${target}`]),
  ]);

  for (const scope of readdirSync(join(runtime, "node_modules"))) {
    if (!scope.startsWith("@")) throw new Error(`Unexpected runtime dependency: ${scope}`);

    for (const name of readdirSync(join(runtime, "node_modules", scope)))
      if (!allowed.has(`${scope}/${name}`)) throw new Error(`Unexpected runtime dependency: ${scope}/${name}`);
  }

  const binding = join(runtime, "node_modules/@img", `sharp-${target}`, "lib");

  if (!existsSync(binding) || !readdirSync(binding).some((name) => name.endsWith(".node")))
    throw new Error("Packaged sharp native binding missing");

  if (!existsSync(join(runtime, "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs")))
    throw new Error("Packaged Claude SDK missing");

  if (!existsSync(join(runtime, "web/client/_app"))) throw new Error("Packaged SvelteKit client assets missing");

  if (electronPlatformName === "darwin") {
    // afterPack runs before signing. Include extensionless executables, dylibs and native modules.
    const { machOFiles, machOArchitectures } = require("./macho.cjs");
    const native = join(resources, "native/quit-key-event.node");

    if (!existsSync(native)) throw new Error("Packaged quit key event adapter missing");
    const binaries = machOFiles(runtime);

    if (!binaries.length) throw new Error("No macOS runtime binaries found");

    if (machOArchitectures(native).join() !== "arm64")
      throw new Error("Quit key event adapter must be an arm64 Mach-O");
    binaries.push(native);

    for (const binary of machOFiles(application))
      if (machOArchitectures(binary).join() !== "arm64")
        throw new Error(`Packaged Mach-O must be arm64 only: ${binary}`);
    packager.platformSpecificBuildOptions.binaries = binaries;
    console.info(`Signing ${binaries.length} runtime Mach-O files with inherited JIT entitlements`);
  }

  for (const name of ["controller", "gateway", "worker", "web"]) {
    if (existsSync(join(runtime, `canopy-${name}${suffix}`))) throw new Error("Duplicate compiled Bun runtime found");
  }

  const metrics = packageMetrics(application, resources, target);
  writeFileSync(join(appOutDir, "..", `package-sizes-${target}.json`), JSON.stringify(metrics, null, 2));
  console.info(
    `Packaged ${target}: ${(metrics.total / 1024 ** 2).toFixed(1)} MiB (budget ${metrics.budget / 1024 ** 2} MiB)`,
  );
};
