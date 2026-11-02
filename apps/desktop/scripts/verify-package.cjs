const { existsSync, readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");

// Validate the final resources, not the build directory. electron-builder deliberately
// filters a root node_modules directory unless it has its own resource mapping.
module.exports = async ({ appOutDir, electronPlatformName }) => {
  const resources = electronPlatformName === "darwin" ? join(appOutDir, "Canopy.app/Contents/Resources") : join(appOutDir, "resources");
  const runtime = join(resources, "runtime");
  const { target } = JSON.parse(readFileSync(join(runtime, "target.json"), "utf8"));
  const suffix = electronPlatformName === "win32" ? ".exe" : "";
  for (const name of ["bun", "canopy-controller", "canopy-gateway", "canopy-worker", "canopy-web"]) {
    if (!existsSync(join(runtime, name + suffix))) throw new Error(`Packaged sidecar missing: ${name}`);
  }
  for (const name of ["initdb", "postgres", "pg_ctl"]) {
    if (!existsSync(join(runtime, "postgres/bin", name + suffix))) throw new Error(`Packaged PostgreSQL binary missing: ${name}`);
  }
  const binding = join(runtime, "node_modules/@img", `sharp-${target}`, "lib");
  if (!existsSync(binding) || !readdirSync(binding).some((name) => name.endsWith(".node"))) throw new Error("Packaged sharp native binding missing");
  if (!existsSync(join(runtime, "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs"))) throw new Error("Packaged Claude SDK missing");
  if (!existsSync(join(runtime, "web/client/_app"))) throw new Error("Packaged SvelteKit client assets missing");
};
