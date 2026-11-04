import {
  chmodSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { noAgentClis } from "../../../scripts/agent-clis.ts";
import type { JsonObject, JsonValue } from "@canopy/domain";
import { isString } from "../src/runtime/config.ts";

// SAFETY: This repository-owned CommonJS module exports thinMachOFiles with the signature declared below.
const { thinMachOFiles } = require("./macho.cjs") as { thinMachOFiles(directory: string, arch: string): void };

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const root = resolve(import.meta.dir, "../../..");
const desktop = join(root, "apps/desktop");
const target = process.env["CANOPY_TARGET"] ?? `${process.platform}-${process.arch}`;
const supported = ["linux-x64", "linux-arm64", "darwin-arm64", "win32-x64"];

if (!supported.includes(target)) throw new Error(`Unsupported desktop target: ${target}`);

// Native sharp, electron-builder and dmg need a matching OS/arch runner.
if (target !== `${process.platform}-${process.arch}`)
  throw new Error(`Build ${target} on a matching OS/architecture runner; cross-host native assets are not supported`);

const suffix = process.platform === "win32" ? ".exe" : "";
const runtime = join(desktop, "build/runtime");

rmSync(runtime, { recursive: true, force: true });

mkdirSync(runtime, { recursive: true });

async function run(args: string[], cwd = root, env: NodeJS.ProcessEnv = process.env) {
  const child = Bun.spawn(args, { cwd, env, stdio: ["inherit", "inherit", "inherit"] });

  if ((await child.exited) !== 0) throw new Error(`Build command failed: ${args[1] ?? args[0]}`);
}

await run([process.execPath, "scripts/prepare-identity.ts"], desktop);

await run([process.execPath, "scripts/build-shell.ts"], desktop);

await run([process.execPath, "run", "build"], join(root, "apps/web"));

cpSync(join(root, "apps/web/build"), join(runtime, "web"), { recursive: true });

// Bundle adapter-node separately from its client assets. Only this generated
// desktop copy gets a resource-directory override; the normal web build stays untouched.
const adapterConfig = join(runtime, "web/adapter-node.js");
const adapterSource = readFileSync(adapterConfig, "utf8");
const directoryDeclaration = "export const dir = dirname(fileURLToPath(import.meta.url));";

if (!adapterSource.includes(directoryDeclaration))
  throw new Error("adapter-node layout changed; review the desktop asset path override");

// adapter-node 6 has no runtime ORIGIN: without a proxy header it treats every request as https,
// so SvelteKit's CSRF check rejects the window's http://127.0.0.1 forms. The runtime knows the exact origin.
const originDeclaration = "export const origin = undefined;";

if (!adapterSource.includes(originDeclaration))
  throw new Error("adapter-node layout changed; review the desktop origin override");

writeFileSync(
  adapterConfig,
  adapterSource
    .replace(directoryDeclaration, 'export const dir = process.env["CANOPY_WEB_ASSETS_DIR"];')
    .replace(originDeclaration, 'export const origin = process.env["CANOPY_WEB_ORIGIN"];'),
);

const webEntry = join(runtime, "web/index.js");

writeFileSync(
  webEntry,
  'process.stdin.on("end", () => process.emit("SIGTERM")); process.stdin.resume();\n' + readFileSync(webEntry, "utf8"),
);

copyFileSync(process.execPath, join(runtime, `bun${suffix}`));

chmodSync(join(runtime, `bun${suffix}`), 0o755);

const pgName = target.replace("win32", "windows");
const pgPackage = resolve(dirname(realpathSync(require.resolve(`@embedded-postgres/${pgName}`))), "..");
const pgManifest: JsonValue = JSON.parse(readFileSync(join(pgPackage, "package.json"), "utf8"));
const pgVersion = isJsonObject(pgManifest) ? pgManifest["version"] : undefined;

if (pgVersion !== "18.6.0-beta.19") throw new Error("Unexpected PostgreSQL binary version");

// All JS dependencies are bundled except this self-contained SDK. Copy the exact
// installed files, without a second dependency resolution or workspace sources.
writeFileSync(join(runtime, "package.json"), JSON.stringify({ private: true, type: "module" }));

const sdk = dirname(realpathSync(require.resolve("@anthropic-ai/claude-agent-sdk")));
const sdkDestination = join(runtime, "node_modules/@anthropic-ai/claude-agent-sdk");

mkdirSync(sdkDestination, { recursive: true });

for (const name of ["sdk.mjs", "package.json", "README.md", "LICENSE.md"])
  copyFileSync(join(sdk, name), join(sdkDestination, name));

const externalPackages = [
  `@img/sharp-${target}`,
  ...(process.platform === "win32" ? [] : [`@img/sharp-libvips-${target}`]),
];

for (const name of externalPackages) {
  const source = join(root, "node_modules", name);
  cpSync(source, join(runtime, "node_modules", name), { recursive: true, dereference: false, verbatimSymlinks: true });
}

// Only the local-mode database is downloaded. Agent CLIs are never bundled or
// downloaded: users install claude/codex/grok on their own machine.
const packageName = `@embedded-postgres/${pgName}`;
const version = pgVersion;

// SAFETY: Bun.JSONC.parse produces JSON data; the object and package-entry shapes are checked below.
const lock = Bun.JSONC.parse(readFileSync(join(root, "bun.lock"), "utf8")) as JsonValue;

if (!isJsonObject(lock) || !isJsonObject(lock["packages"])) throw new Error("Invalid bun.lock packages");

const entry = lock["packages"][packageName];
const pinned = Array.isArray(entry) ? entry : undefined;
const integrity = pinned?.at(-1);

if (
  pinned?.[0] !== `${packageName}@${version}` ||
  !isString(integrity) ||
  !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)
)
  throw new Error("PostgreSQL distribution is not pinned with SHA-512 in bun.lock");

writeFileSync(
  join(runtime, "postgres.json"),
  JSON.stringify({ packageName, version, major: Number(version.split(".")[0]), target, integrity }, null, 2),
);

for (const [name, entry] of Object.entries({
  controller: "src/controller.ts",
  gateway: "src/sidecars/gateway.ts",
  worker: "src/sidecars/worker.ts",
  web: webEntry,
})) {
  const build = await Bun.build({
    entrypoints: [resolve(desktop, entry)],
    target: "bun",
    // The one Canopy version (scripts/version.ts) in the sidecars; the web build reads the same variable.
    ...(process.env["CANOPY_VERSION"] && {
      define: { "process.env.CANOPY_VERSION": JSON.stringify(process.env["CANOPY_VERSION"]) },
    }),
    outdir: runtime,
    naming: `canopy-${name}.js`,
    minify: { syntax: true, whitespace: true },
    sourcemap: "none",
    plugins: [
      noAgentClis,
      {
        name: "desktop-native-modules",
        setup(builder) {
          builder.onLoad({ filter: /[/\\]sharp[/\\]dist[/\\]sharp\.[cm]js$/ }, ({ path }) => {
            const nativeDirectory = join(
              dirname(realpathSync(require.resolve(`@img/sharp-${target}/sharp.node`))),
              "lib",
            );

            const bindingFile = readdirSync(nativeDirectory).find((name) => name.endsWith(".node"));

            if (!bindingFile) throw new Error("sharp native binding is missing");

            const native = relative(join(root, "node_modules"), join(nativeDirectory, bindingFile))
              .split("\\")
              .join("/");

            return {
              loader: "js",
              contents: `const {dirname,join}=require('node:path'); const binding={exports:{}}; process.dlopen(binding,join(dirname(process.execPath),'node_modules',${JSON.stringify(native)})); ${path.endsWith("mjs") ? "export default binding.exports;" : "module.exports=binding.exports;"}`,
            };
          });
          builder.onResolve({ filter: /^@anthropic-ai\/claude-agent-sdk$/ }, ({ path }) => ({
            path,
            namespace: "desktop-native",
          }));
          builder.onLoad({ filter: /.*/, namespace: "desktop-native" }, ({ path }) => ({
            loader: "js",
            contents: `import {createRequire} from 'node:module'; import {dirname,join} from 'node:path';
          const load = createRequire(join(dirname(process.execPath), 'package.json'));
          const library = load(join(dirname(process.execPath), 'node_modules', ${JSON.stringify(path === "sharp" ? "sharp/dist/index.cjs" : "@anthropic-ai/claude-agent-sdk/sdk.mjs")}));
          ${path === "sharp" ? "export default library;" : "export const {query, forkSession, getSessionMessages, createSdkMcpServer} = library;"}`,
          }));
          // Match standalone releases: ssh2 falls back to JS without these optional,
          // host-built addons. Do not accidentally copy a build machine's .node file.
          builder.onLoad({ filter: /[/\\]cpu-features[/\\]lib[/\\]index\.js$/ }, () => ({
            loader: "js",
            contents: 'throw new Error("cpu-features is not bundled");',
          }));
          builder.onResolve({ filter: /sshcrypto\.node$/ }, () => ({
            path: "sshcrypto",
            namespace: "desktop-no-addon",
          }));
          builder.onLoad({ filter: /.*/, namespace: "desktop-no-addon" }, () => ({
            loader: "js",
            contents: 'throw new Error("sshcrypto is not bundled");',
          }));
        },
      },
    ],
  });

  if (!build.success) throw new AggregateError(build.logs, `Sidecar compilation failed: ${name}`);
}

copyFileSync(join(desktop, "THIRD_PARTY_NOTICES.md"), join(runtime, "THIRD_PARTY_NOTICES.md"));

cpSync(join(desktop, "licenses"), join(runtime, "licenses"), { recursive: true });

copyFileSync(join(pgPackage, "LICENSE.md"), join(runtime, "licenses/postgres-distribution-LICENSE.md"));

if (process.platform === "darwin") thinMachOFiles(runtime, process.arch);

writeFileSync(join(runtime, "target.json"), JSON.stringify({ target, bun: Bun.version, postgres: pgVersion }));

console.info(`Canopy desktop runtime ready: ${target}`);
