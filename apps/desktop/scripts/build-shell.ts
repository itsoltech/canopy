import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { desktopIdentity } from "../src/identity.ts";
const root = resolve(import.meta.dir, "..");
mkdirSync(resolve(root, "dist"), { recursive: true });
for (const name of ["main", "preload"]) {
  const result = await Bun.build({ entrypoints: [resolve(root, `src/${name}.ts`)], target: "node", format: "cjs", external: ["electron", "electron-updater"], define: { CANOPY_DESKTOP_CHANNEL: JSON.stringify(desktopIdentity().channel) }, naming: `${name}.cjs`, outdir: resolve(root, "dist") });
  if (!result.success) throw new AggregateError(result.logs, "Electron shell build failed");
}
writeFileSync(resolve(root, "dist/identity.json"), JSON.stringify(desktopIdentity()));
