const { existsSync, readFileSync, readdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { listPackage } = require("@electron/asar");
const { Arch } = require("electron-builder");
const { packageMetrics } = require("./package-metrics.cjs");

function verifySidebarIcons(preparedRuntime, runtime) {
  const channels = "web/client/channels";
  const preparedChannels = join(preparedRuntime, channels);

  // A recovery build can use a runtime from before channel-specific artwork.
  if (!existsSync(preparedChannels)) return;

  for (const channel of readdirSync(preparedChannels)) {
    const icon = `${channels}/${channel}/icon.svg`;

    if (!existsSync(join(preparedRuntime, icon))) continue;

    // Adapter-node negotiates precompressed variants from its build-time asset table.
    for (const suffix of ["", ".br", ".gz"]) {
      const asset = icon + suffix;
      const prepared = join(preparedRuntime, asset);
      const packaged = join(runtime, asset);

      if (!existsSync(prepared)) throw new Error(`Built sidebar icon asset missing: ${asset}`);

      if (!existsSync(packaged)) throw new Error(`Packaged sidebar icon asset missing: ${asset}`);

      if (!readFileSync(packaged).equals(readFileSync(prepared)))
        throw new Error(`Packaged sidebar icon asset differs from the web build: ${asset}`);
    }
  }
}

// Validate the final resources, not the build directory. electron-builder deliberately
// filters a root node_modules directory unless it has its own resource mapping.
module.exports = async ({ appOutDir, electronPlatformName, arch, packager }) => {
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
  const architecture = Arch[arch];
  const expectedTarget = `${electronPlatformName}-${architecture}`;

  if (target !== expectedTarget) throw new Error(`Expected ${expectedTarget} runtime, got ${target}`);
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

  // Recovery can package an earlier runtime with the current workflow.
  const preparedRuntime = join(packager.projectDir, "build/runtime");
  verifySidebarIcons(preparedRuntime, runtime);
  const generatedNotices = ["THIRD_PARTY_NOTICES.txt", "web/client/open-source-licenses.json"];

  const requiredNotices = generatedNotices.some((path) => existsSync(join(preparedRuntime, path)))
    ? generatedNotices
    : ["THIRD_PARTY_NOTICES.md"];

  for (const path of requiredNotices) {
    if (!existsSync(join(runtime, path))) throw new Error(`Packaged third-party notices missing: ${path}`);
  }

  if (electronPlatformName === "darwin") {
    // afterPack runs before signing. Include extensionless executables, dylibs and native modules.
    const { machOFiles, machOArchitectures } = require("./macho.cjs");
    const binaries = machOFiles(runtime);

    if (!binaries.length) throw new Error("No macOS runtime binaries found");

    for (const name of ["quit-key-event.node", "notification-permission.node"]) {
      const addon = join(resources, "native", name);

      if (!existsSync(addon)) throw new Error(`Packaged native addon missing: ${name}`);

      if (machOArchitectures(addon).join() !== architecture)
        throw new Error(`Native addon must be a ${architecture} Mach-O: ${name}`);
      binaries.push(addon);
    }

    for (const binary of machOFiles(application))
      if (machOArchitectures(binary).join() !== architecture)
        throw new Error(`Packaged Mach-O must be ${architecture} only: ${binary}`);
    const { prepareMacPresentation } = require("./macos-presentation.cjs");
    prepareMacPresentation(resources, packager.platformSpecificBuildOptions.extendInfo.CFBundleIconFile);
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
