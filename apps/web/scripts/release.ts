import { existsSync, lstatSync, mkdirSync, readlinkSync, readdirSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildVersion } from "./build-version.ts";
import { spawnSync } from "node:child_process";

const web = resolve(import.meta.dir, "..");
const root = resolve(web, process.env["WEB_RELEASES_DIR"] ?? "releases");
const keep = Number(process.env["WEB_RELEASE_KEEP"] ?? 3);
if (!Number.isInteger(keep) || keep < 2) throw new Error("WEB_RELEASE_KEEP must be an integer >= 2");
mkdirSync(root, { recursive: true });
const lock = join(root, ".build-lock");
mkdirSync(lock); // One build at a time: Vite also shares .svelte-kit/output.
const version = buildVersion();
const output = join(root, version);
const current = join(root, "current");
const next = join(root, ".current-next");
let published = false;
try {
  if (existsSync(current) && !lstatSync(current).isSymbolicLink()) throw new Error("current must be a symlink");
  const releases = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "immutable-files.json")))
    .map((entry) => join(root, entry.name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  const previous = existsSync(current) ? resolve(root, readlinkSync(current)) : undefined;
  const retained = [...new Set([...(previous ? [previous] : []), ...releases])].slice(0, keep - 1);
  // Migrate the old in-place build too, until enough real releases fill the retention window.
  const legacy = join(web, "build");
  if (retained.length < keep - 1 && existsSync(join(legacy, "client/_app/immutable"))) retained.push(legacy);
  mkdirSync(output); // Never let adapter-node empty an existing or running release.
  const build = spawnSync("bun", ["run", "build"], {
    cwd: web,
    env: { ...process.env, BUILD_DIR: output, WEB_BUILD_VERSION: version, WEB_PREVIOUS_RELEASES: JSON.stringify(retained) },
    stdio: "inherit",
  });
  if (build.status !== 0) throw new Error("Web build failed; current is unchanged");
  symlinkSync(version, next);
  renameSync(next, current);
  published = true;
  for (const release of releases) if (!retained.includes(release)) rmSync(release, { recursive: true });
  console.log(`Web release ready: ${current}/index.js (${version})`);
} finally {
  rmSync(next, { force: true });
  if (!published) rmSync(output, { recursive: true, force: true });
  rmSync(lock, { recursive: true });
}
