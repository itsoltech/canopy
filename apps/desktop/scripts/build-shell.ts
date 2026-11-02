import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(import.meta.dir, "..");
mkdirSync(resolve(root, "dist"), { recursive: true });
for (const name of ["main", "preload"]) {
  const result = await Bun.build({ entrypoints: [resolve(root, `src/${name}.ts`)], target: "node", format: "cjs", external: ["electron"], naming: `${name}.cjs`, outdir: resolve(root, "dist") });
  if (!result.success) throw new AggregateError(result.logs, "Electron shell build failed");
}
