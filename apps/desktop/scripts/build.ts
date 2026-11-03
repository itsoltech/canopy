import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");
const desktop = join(root, "apps/desktop");
const target = process.env["CANOPY_TARGET"] ?? `${process.platform}-${process.arch}`;
const supported = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64"];
if (!supported.includes(target)) throw new Error(`Unsupported desktop target: ${target}`);
// Native packages (sharp, Claude SDK), electron-builder and dmg need a matching OS/arch runner.
if (target !== `${process.platform}-${process.arch}`) throw new Error(`Build ${target} on a matching OS/architecture runner; cross-host native assets are not supported`);
const suffix = process.platform === "win32" ? ".exe" : "";
const runtime = join(desktop, "build/runtime");
rmSync(runtime, { recursive: true, force: true });
mkdirSync(runtime, { recursive: true });
async function run(args: string[], cwd = root, env: NodeJS.ProcessEnv = process.env) {
  const child = Bun.spawn(args, { cwd, env, stdio: ["inherit", "inherit", "inherit"] });
  if (await child.exited !== 0) throw new Error(`Build command failed: ${args[1] ?? args[0]}`);
}
await run([process.execPath, "scripts/prepare-identity.ts"], desktop);
await run([process.execPath, "scripts/build-shell.ts"], desktop);
await run([process.execPath, "run", "build"], join(root, "apps/web"));
cpSync(join(root, "apps/web/build"), join(runtime, "web"), { recursive: true });
// Compile adapter-node without embedding the client assets in $bunfs. Only this generated
// desktop copy gets a resource-directory override; the normal web build stays untouched.
const adapterConfig = join(runtime, "web/adapter-node.js");
const adapterSource = readFileSync(adapterConfig, "utf8");
const directoryDeclaration = "export const dir = dirname(fileURLToPath(import.meta.url));";
if (!adapterSource.includes(directoryDeclaration)) throw new Error("adapter-node layout changed; review the desktop asset path override");
writeFileSync(adapterConfig, adapterSource.replace(directoryDeclaration, 'export const dir = process.env["CANOPY_WEB_ASSETS_DIR"];'));
const webEntry = join(runtime, "web/index.js");
writeFileSync(webEntry, 'process.stdin.on("end", () => process.emit("SIGTERM")); process.stdin.resume();\n' + readFileSync(webEntry, "utf8"));
copyFileSync(process.execPath, join(runtime, `bun${suffix}`));
chmodSync(join(runtime, `bun${suffix}`), 0o755);
const pgName = target.replace("win32", "windows");
const pgPackage = resolve(dirname(realpathSync(require.resolve(`@embedded-postgres/${pgName}`))), "..");
const pgVersion = (JSON.parse(readFileSync(join(pgPackage, "package.json"), "utf8")) as { version: string }).version;
if (pgVersion !== "18.6.0-beta.19") throw new Error("Unexpected PostgreSQL binary version");
cpSync(join(pgPackage, "native"), join(runtime, "postgres"), { recursive: true, dereference: false, verbatimSymlinks: true });
const links = join(pgPackage, "native/pg-symlinks.json");
if (existsSync(links)) {
  for (const { source, target: link } of JSON.parse(readFileSync(links, "utf8")) as { source: string; target: string }[]) {
    const destination = join(runtime, "postgres", relative("native", link));
    if (!existsSync(destination)) symlinkSync(relative(dirname(destination), join(runtime, "postgres", relative("native", source))), destination);
  }
}
// Keep SDK assets and sharp's native modules as files next to the compiled sidecars.
// These dependencies are pinned by the repository; workspace packages remain source-only copies.
const manifests = ["apps/gateway", "apps/worker", "apps/web"].map((name) => JSON.parse(readFileSync(join(root, name, "package.json"), "utf8")) as { dependencies: Record<string, string> });
const dependencies: Record<string, string> = {};
for (const manifest of manifests) for (const [name, version] of Object.entries(manifest.dependencies)) if (!version.startsWith("workspace:")) dependencies[name] = version;
writeFileSync(join(runtime, "package.json"), JSON.stringify({ private: true, type: "module", dependencies }, null, 2));
await run([process.execPath, "install", "--production", "--ignore-scripts"], runtime);
for (const name of ["contracts", "domain", "ui", "transport", "db", "grok-acp", "codex-protocol"]) {
  const destination = join(runtime, "node_modules/@canopy", name);
  mkdirSync(destination, { recursive: true });
  cpSync(join(root, "packages", name, "src"), join(destination, "src"), { recursive: true, filter: (path) => !/\.(?:test|live\.test)\.ts$/.test(path) && !path.includes("/fixtures/") });
  copyFileSync(join(root, "packages", name, "package.json"), join(destination, "package.json"));
}
for (const [name, entry] of Object.entries({ controller: "src/controller.ts", gateway: "src/sidecars/gateway.ts", worker: "src/sidecars/worker.ts", web: webEntry })) {
  const output = join(runtime, `canopy-${name}${suffix}`);
  const build = await Bun.build({
    entrypoints: [resolve(desktop, entry)], target: "bun",
    // The one Canopy version (scripts/version.ts) in the sidecars; the web build reads the same variable.
    ...(process.env["CANOPY_VERSION"] && { define: { "process.env.CANOPY_VERSION": JSON.stringify(process.env["CANOPY_VERSION"]) } }),
    compile: { target: `bun-${target.replace("win32", "windows")}` as Bun.Build.CompileTarget, outfile: output },
    plugins: [{ name: "desktop-native-modules", setup(builder) {
      builder.onLoad({ filter: /[/\\]sharp[/\\]dist[/\\]sharp\.[cm]js$/ }, ({ path }) => {
        const nativeDirectory = join(dirname(realpathSync(require.resolve(`@img/sharp-${target}/sharp.node`))), "lib");
        const bindingFile = readdirSync(nativeDirectory).find((name) => name.endsWith(".node"));
        if (!bindingFile) throw new Error("sharp native binding is missing");
        const native = relative(join(root, "node_modules"), join(nativeDirectory, bindingFile)).split("\\").join("/");
        return { loader: "js", contents: `const {dirname,join}=require('node:path'); const binding={exports:{}}; process.dlopen(binding,join(dirname(process.execPath),'node_modules',${JSON.stringify(native)})); ${path.endsWith("mjs") ? "export default binding.exports;" : "module.exports=binding.exports;"}` };
      });
      builder.onResolve({ filter: /^@anthropic-ai\/claude-agent-sdk$/ }, ({ path }) => ({ path, namespace: "desktop-native" }));
      builder.onLoad({ filter: /.*/, namespace: "desktop-native" }, ({ path }) => ({
        loader: "js",
        contents: `import {createRequire} from 'node:module'; import {dirname,join} from 'node:path';
          const load = createRequire(join(dirname(process.execPath), 'package.json'));
          const library = load(join(dirname(process.execPath), 'node_modules', ${JSON.stringify(path === "sharp" ? "sharp/dist/index.cjs" : "@anthropic-ai/claude-agent-sdk/sdk.mjs")}));
          ${path === "sharp" ? "export default library;" : "export const {query, forkSession, getSessionMessages, createSdkMcpServer} = library;"}`,
      }));
    } }],
  });
  if (!build.success) throw new AggregateError(build.logs, `Sidecar compilation failed: ${name}`);
  chmodSync(output, 0o755);
}
copyFileSync(join(desktop, "THIRD_PARTY_NOTICES.md"), join(runtime, "THIRD_PARTY_NOTICES.md"));
cpSync(join(desktop, "licenses"), join(runtime, "licenses"), { recursive: true });
copyFileSync(join(pgPackage, "LICENSE.md"), join(runtime, "postgres/DISTRIBUTION-LICENSE.md"));
writeFileSync(join(runtime, "target.json"), JSON.stringify({ target, bun: Bun.version, postgres: pgVersion }));
console.info(`Canopy desktop runtime ready: ${target}`);
