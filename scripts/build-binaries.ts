/**
 * Standalone gateway and worker binaries (`bun build --compile`, docs/release.md):
 * `dist/release/canopy-<app>-<os>-<arch>[.exe]`.
 *
 * `bun scripts/build-binaries.ts [--target linux-x64,darwin-arm64,…|all] [--app gateway,worker] [--outdir DIR]`
 * Defaults: the host target, both apps, dist/release. CANOPY_VERSION overrides scripts/version.ts.
 *
 * Everything JavaScript is bundled (SQL migrations are text imports, proto code is generated TS). The one native
 * dependency, sharp, is embedded per target together with its libvips and extracted on first use to a cache
 * directory (CANOPY_NATIVE_DIR, else the user cache dir), keeping sharp's relative layout so its rpath still
 * finds libvips. Other targets' sharp packages come from the npm registry, checked against their integrity.
 * The worker spawns the agent CLIs (claude, codex, grok) from PATH; they are not part of the binary.
 *
 * `--web DIR` (a `scripts/build-web.ts` output of the same version) embeds the web into the gateway as one
 * zstd archive; the binary serves it with `canopy-gateway web` (apps/gateway/src/web, docs/deploy.md).
 * Without it the gateway is headless. Release binaries and the gateway image embed it.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { currentVersion } from "./version.ts";
import { noAgentClis } from "./agent-clis.ts";
import { packWeb, webBuildVersion } from "../apps/gateway/src/web/archive.ts";

export const TARGETS = ["linux-x64", "linux-arm64", "darwin-arm64", "windows-x64"] as const;

export type Target = (typeof TARGETS)[number];

export const APPS = { gateway: "apps/gateway/src/main.ts", worker: "apps/worker/src/main.ts" } as const;

export type App = keyof typeof APPS;

const root = resolve(import.meta.dir, "..");
const cache = join(root, ".tmp/release-native");

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isPackageVersion(value: unknown): value is { version: string } {
  return !!value && typeof value === "object" && "version" in value && isString(value.version);
}

interface SharpPackage {
  version: string;
  optionalDependencies: Record<string, string>;
}

function isSharpPackage(value: unknown): value is SharpPackage {
  return (
    isPackageVersion(value) &&
    "optionalDependencies" in value &&
    !!value.optionalDependencies &&
    typeof value.optionalDependencies === "object" &&
    !Array.isArray(value.optionalDependencies) &&
    Object.values(value.optionalDependencies).every(isString)
  );
}

function isNpmDistribution(value: unknown): value is { dist: { tarball: string; integrity: string } } {
  return (
    !!value &&
    typeof value === "object" &&
    "dist" in value &&
    !!value.dist &&
    typeof value.dist === "object" &&
    "tarball" in value.dist &&
    isString(value.dist.tarball) &&
    "integrity" in value.dist &&
    isString(value.dist.integrity)
  );
}

function isTarget(value: string): value is Target {
  return TARGETS.some((target) => target === value);
}

function isApp(value: string): value is App {
  return value === "gateway" || value === "worker";
}

/** `canopy-gateway-linux-x64`, `canopy-worker-windows-x64.exe` (the release asset names). */
export const binaryName = (app: App, target: Target) =>
  `canopy-${app}-${target}${target.startsWith("windows") ? ".exe" : ""}`;

/** sharp's npm platform name for a target. */
const sharpPlatform = (target: Target) => target.replace("windows", "win32");

function sharpVersions() {
  const pkg: unknown = JSON.parse(readFileSync(join(root, "node_modules/sharp/package.json"), "utf8"));

  if (!isSharpPackage(pkg)) throw new Error("Invalid sharp package metadata");

  const libvips = pkg.optionalDependencies["@img/sharp-libvips-linux-x64"];

  if (!libvips) throw new Error("sharp no longer lists @img/sharp-libvips-*: review scripts/build-binaries.ts");

  return { sharp: pkg.version, libvips };
}

/** The unpacked package directory: the installed one when it matches, else downloaded from the registry once. */
async function npmPackage(name: string, version: string): Promise<string> {
  const installed = join(root, "node_modules", name);

  if (existsSync(join(installed, "package.json"))) {
    const pkg: unknown = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));

    if (isPackageVersion(pkg) && pkg.version === version) return installed;
  }

  const directory = join(cache, `${name.replace("/", "+")}@${version}`);

  if (existsSync(join(directory, "package/package.json"))) return join(directory, "package");
  const meta = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2f")}/${version}`);

  if (!meta.ok) throw new Error(`npm registry: ${name}@${version}: HTTP ${meta.status}`);
  const distribution: unknown = await meta.json();

  if (!isNpmDistribution(distribution)) throw new Error(`npm registry: invalid distribution for ${name}@${version}`);
  const { dist } = distribution;
  const tarball = new Uint8Array(await (await fetch(dist.tarball)).arrayBuffer());
  const [algorithm, expected] = dist.integrity.split("-", 2);

  if (!algorithm || !expected) throw new Error(`${name}@${version}: integrity mismatch`);

  if (createHash(algorithm).update(tarball).digest("base64") !== expected)
    throw new Error(`${name}@${version}: integrity mismatch`);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  await Bun.write(join(directory, "package.tgz"), tarball);
  const untar = Bun.spawnSync(["tar", "-xzf", "package.tgz"], { cwd: directory, stderr: "inherit" });

  if (untar.exitCode !== 0) throw new Error(`${name}@${version}: tar failed`);
  rmSync(join(directory, "package.tgz"));

  return join(directory, "package");
}

/** Files of sharp's native build for a target, as [path relative to the extraction root, absolute source]. */
async function sharpFiles(target: Target): Promise<[string, string][]> {
  const { sharp, libvips } = sharpVersions();
  const platform = sharpPlatform(target);
  const packages: [string, string][] = [[`@img/sharp-${platform}`, sharp]];

  // Windows ships libvips inside the sharp package; elsewhere it is a separate package found through the rpath.
  if (!target.startsWith("windows")) packages.push([`@img/sharp-libvips-${platform}`, libvips]);
  const files: [string, string][] = [];

  for (const [name, version] of packages) {
    const directory = await npmPackage(name, version);

    for (const file of readdirSync(join(directory, "lib"), { recursive: true, encoding: "utf8" })) {
      const path = join(directory, "lib", file);

      if (!statSync(path).isFile() || file === "index.js" || file.endsWith(".h")) continue;
      files.push([`${name}/lib/${file.split("\\").join("/")}`, path]);
    }
  }

  // dlopen() the addon itself; the libraries it needs are found next to it (Windows) or through its rpath.
  const addon = files.findIndex(([path]) => path.endsWith(".node"));

  if (addon < 0) throw new Error(`sharp ${platform}: no .node addon`);
  files.unshift(...files.splice(addon, 1));

  return files;
}

/** The module replacing sharp's platform probe: extracts the embedded files once, then loads the addon. */
function sharpLoader(files: [string, string][]): string {
  const key = createHash("sha256");

  for (const [path, source] of files) key.update(path).update(readFileSync(source));

  const imports = files
    .map(([, source], i) => `import f${i} from ${JSON.stringify(source)} with { type: "file" };`)
    .join("\n");

  const table = files.map(([path], i) => `[${JSON.stringify(path)}, f${i}]`).join(", ");

  return `${imports}
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
const files = [${table}];
const key = ${JSON.stringify(key.digest("hex").slice(0, 16))};
function cacheDir() {
  if (process.env.CANOPY_NATIVE_DIR) return process.env.CANOPY_NATIVE_DIR;
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "canopy", "native");
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "canopy", "native");
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "canopy", "native");
}
function extract(directory) {
  for (const [path, embedded] of files) {
    const target = join(directory, path);
    const data = readFileSync(embedded);
    if (existsSync(target) && statSync(target).size === data.length) continue;
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const partial = target + "." + process.pid + ".partial";
    writeFileSync(partial, data, { mode: 0o755 });
    renameSync(partial, target);
  }
  return join(directory, files[0][0]);
}
let addon;
try { addon = extract(join(cacheDir(), key)); } catch { addon = extract(mkdtempSync(join(tmpdir(), "canopy-native-"))); }
const binding = { exports: {} };
process.dlopen(binding, addon);
export default binding.exports;
`;
}

/** A packed web build for the gateway (apps/gateway/src/web/embedded.ts). */
export interface WebArchive {
  file: string;
  key: string;
  version: string;
}

/** Packs a web build once for every gateway target; its version must be the binaries' version. */
export async function webArchive(build: string, version: string): Promise<WebArchive> {
  const built = await webBuildVersion(build);

  if (built !== version)
    throw new Error(`${build} is web ${built}, not ${version}: rebuild it with the same CANOPY_VERSION`);
  const bytes = await packWeb(build, version);
  const key = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const directory = join(root, ".tmp/release-web");
  // One packed build at a time: earlier ones are 13 MiB each.
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `web-${key}.zst`);
  await Bun.write(file, bytes);

  return { file, key, version };
}

/** Replaces the gateway's empty EMBEDDED_WEB with the embedded archive. */
export function embeddedWebPlugin(web: WebArchive): Bun.BunPlugin {
  return {
    name: "canopy-embedded-web",
    setup(builder) {
      builder.onLoad({ filter: /[/\\]gateway[/\\]src[/\\]web[/\\]embedded\.ts$/ }, () => ({
        loader: "js",
        contents: `import file from ${JSON.stringify(web.file)} with { type: "file" };
export const EMBEDDED_WEB = { file, key: ${JSON.stringify(web.key)}, version: ${JSON.stringify(web.version)} };`,
      }));
    },
  };
}

export function buildBinary(
  app: App,
  target: Target,
  options: { outdir: string; version: string; web?: WebArchive },
): Promise<string> {
  const outfile = join(options.outdir, binaryName(app, target));

  return compile(join(root, APPS[app]), outfile, target, options.version, app === "gateway" ? options.web : undefined);
}

/** One entry point compiled for a target, with sharp (and, for the gateway, optionally the web) embedded. */
export async function compile(
  entry: string,
  outfile: string,
  target: Target,
  version: string,
  web?: WebArchive,
): Promise<string> {
  const native = sharpLoader(await sharpFiles(target));

  const build = await Bun.build({
    entrypoints: [entry, join(root, "apps/worker/src/files/highlight-executor.ts")],
    target: "bun",
    minify: { syntax: true, whitespace: true },
    sourcemap: "none",
    define: { "process.env.CANOPY_VERSION": JSON.stringify(version) },
    compile: { target: `bun-${target}`, outfile },
    plugins: [
      noAgentClis,
      ...(web ? [embeddedWebPlugin(web)] : []),
      {
        name: "canopy-native-sharp",
        setup(builder) {
          // sharp/dist/sharp.{cjs,mjs} probe node_modules for the platform addon; the binary has none.
          builder.onLoad({ filter: /[/\\]sharp[/\\]dist[/\\]sharp\.[cm]js$/ }, ({ path }) => ({
            loader: "js",
            contents: path.endsWith(".mjs")
              ? 'export { default } from "canopy-sharp-native";'
              : 'module.exports = require("canopy-sharp-native").default;',
          }));
          builder.onResolve({ filter: /^canopy-sharp-native$/ }, () => ({
            path: "canopy-sharp-native",
            namespace: "canopy-native",
          }));
          builder.onLoad({ filter: /.*/, namespace: "canopy-native" }, () => ({ loader: "js", contents: native }));
        },
      },
      {
        // ssh2's optional native addons (cpu-features, sshcrypto) are built for the build machine only, if at all
        // (the images install with --ignore-scripts); ssh2 falls back to pure JS when requiring them throws.
        name: "canopy-no-ssh2-addons",
        setup(builder) {
          builder.onLoad({ filter: /[/\\]cpu-features[/\\]lib[/\\]index\.js$/ }, () => ({
            loader: "js",
            contents: 'throw new Error("cpu-features is not bundled");',
          }));
          builder.onResolve({ filter: /sshcrypto\.node$/ }, () => ({
            path: "sshcrypto",
            namespace: "canopy-no-addon",
          }));
          builder.onLoad({ filter: /.*/, namespace: "canopy-no-addon" }, () => ({
            loader: "js",
            contents: 'throw new Error("sshcrypto is not bundled");',
          }));
        },
      },
    ],
  });

  if (!build.success) throw new AggregateError(build.logs, `${outfile}: compilation failed`);

  return outfile;
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    strict: true,
    options: {
      target: { type: "string" },
      app: { type: "string" },
      outdir: { type: "string" },
      web: { type: "string" },
    },
  });

  const host = `${process.platform.replace("win32", "windows")}-${process.arch}`;
  const targetNames = values.target === "all" ? [...TARGETS] : (values.target ?? host).split(",");
  const appNames = (values.app ?? Object.keys(APPS).join(",")).split(",");

  const targets = targetNames.map((target) => {
    if (!isTarget(target)) throw new Error(`Unknown target ${target} (${TARGETS.join(", ")})`);

    return target;
  });

  const apps = appNames.map((app) => {
    if (!isApp(app)) throw new Error(`Unknown app ${app} (${Object.keys(APPS).join(", ")})`);

    return app;
  });

  const version = process.env["CANOPY_VERSION"] || currentVersion().version;
  const outdir = resolve(values.outdir ?? join(root, "dist/release"));
  mkdirSync(outdir, { recursive: true });
  const web = values.web && apps.includes("gateway") ? await webArchive(resolve(values.web), version) : undefined;

  if (web) console.info(`web ${version}: ${(statSync(web.file).size / 1024 ** 2).toFixed(1)} MiB packed`);

  for (const target of targets) {
    for (const app of apps) {
      const started = performance.now();
      const file = await buildBinary(app, target, { outdir, version, ...(web && { web }) });
      console.info(
        `${relative(process.cwd(), file)}  ${(statSync(file).size / 1024 ** 2).toFixed(1)} MiB  ${Math.round(performance.now() - started)} ms`,
      );
    }
  }

  console.info(`Canopy ${version}`);
}
