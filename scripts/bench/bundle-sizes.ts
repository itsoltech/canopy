import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { listOf, objectOf, parseObject, str } from "@canopy/domain/json";

/** Static import closure of each SvelteKit node plus the application shell. Dynamic imports stay separate. */
const directory = resolve(import.meta.dir, "../../apps/web/.svelte-kit/output/client");
const manifest = parseObject(await readFile(resolve(directory, ".vite/manifest.json"), "utf8"));
const names = Object.keys(manifest);
const shell = names.filter((name) => /\/entry\/(start|app)\.js$/.test(name));
const nodes = names.filter((name) => /\/nodes\/\d+\.js$/.test(name));

for (const node of nodes) {
  const visited = new Set<string>();
  const files = new Set<string>();

  const visit = (name: string) => {
    if (visited.has(name)) return;
    visited.add(name);
    const entry = objectOf(manifest[name]);
    const file = str(entry["file"]);

    if (file) files.add(file);

    for (const css of listOf(entry["css"])) if (str(css)) files.add(str(css));

    for (const imported of listOf(entry["imports"])) visit(str(imported));
  };

  for (const name of [...shell, ...nodes.filter((name) => name.endsWith("/nodes/0.js")), node]) visit(name);
  const sizes = { js: 0, css: 0, jsGzip: 0, cssGzip: 0 };

  for (const file of files) {
    const data = await readFile(resolve(directory, file));
    const kind = file.endsWith(".css") ? "css" : "js";
    sizes[kind] += data.byteLength;
    sizes[kind === "css" ? "cssGzip" : "jsGzip"] += gzipSync(data).byteLength;
  }

  console.info(JSON.stringify({ node, ...sizes }));
}

if (!nodes.length) throw new Error("No SvelteKit nodes found; build the web application first");
