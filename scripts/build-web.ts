/**
 * The web BFF as a self-contained directory for the Docker image (docs/release.md):
 * `bun scripts/build-web.ts [--outdir dist/web]` → `index.js` + chunks with every dependency bundled, and `client/`.
 * Run it with `bun index.js`; no node_modules needed. adapter-node serves `client/` next to `index.js`; `handler.js`
 * exports its request handler without listening.
 * `canopy-web.json` records the version; `build-binaries.ts --web` embeds this directory into the gateway.
 * CANOPY_VERSION overrides scripts/version.ts; WEB_BUILD_VERSION (SvelteKit's update check) defaults to it.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { currentVersion } from "./version.ts";

const root = resolve(import.meta.dir, "..");
const { values } = parseArgs({ args: Bun.argv.slice(2), strict: true, options: { outdir: { type: "string" } } });
const outdir = resolve(values.outdir ?? join(root, "dist/web"));
const version = process.env["CANOPY_VERSION"] || currentVersion().version;

mkdirSync(join(root, ".tmp"), { recursive: true });

const staging = mkdtempSync(join(root, ".tmp/web-"));

try {
  const vite = Bun.spawnSync(["bun", "run", "build"], {
    cwd: join(root, "apps/web"),
    env: {
      ...process.env,
      CANOPY_VERSION: version,
      WEB_BUILD_VERSION: process.env["WEB_BUILD_VERSION"] || version,
      BUILD_DIR: staging,
    },
    stdio: ["inherit", "inherit", "inherit"],
  });

  if (vite.exitCode !== 0) throw new Error("web build failed");
  rmSync(outdir, { recursive: true, force: true });

  const bundle = await Bun.build({
    // index.js listens by itself (`bun index.js`); handler.js is adapter-node's request handler, which the gateway
    // mounts in its own process (apps/gateway/src/web/server.ts). They share chunks.
    entrypoints: [join(staging, "index.js"), join(staging, "handler.js")],
    outdir,
    target: "bun",
    splitting: true,
    minify: { syntax: true },
    define: { "process.env.CANOPY_VERSION": JSON.stringify(version) },
  });

  if (!bundle.success) throw new AggregateError(bundle.logs, "web bundle failed");
  cpSync(join(staging, "client"), join(outdir, "client"), { recursive: true });

  if (existsSync(join(staging, "prerendered")))
    cpSync(join(staging, "prerendered"), join(outdir, "prerendered"), { recursive: true });
  await Bun.write(join(outdir, "canopy-web.json"), JSON.stringify({ version }));
  console.info(`Canopy web ${version}: ${outdir}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
