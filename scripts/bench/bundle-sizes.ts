import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { Schema } from "effect";
import { listOf, objectOf, parseObject, str } from "@canopy/domain/json";

/** Static import closure of each SvelteKit node plus the application shell. Dynamic imports stay separate. */
const directory = resolve(import.meta.dir, "../../apps/web/.svelte-kit/output/client");
const manifest = parseObject(await readFile(resolve(directory, ".vite/manifest.json"), "utf8"));
const names = Object.keys(manifest);
const shell = names.filter((name) => /\/entry\/(start|app)\.js$/.test(name));
const nodes = names.filter((name) => /\/nodes\/\d+\.js$/.test(name));

const ServerManifest = Schema.Struct({
  manifest: Schema.Struct({
    routes: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        page: Schema.NullOr(
          Schema.Struct({ layouts: Schema.Array(Schema.NullOr(Schema.Number)), leaf: Schema.Number }),
        ),
      }),
    ),
  }),
});

const server = Schema.decodeUnknownSync(ServerManifest)(
  await import(pathToFileURL(resolve(directory, "../server/manifest-full.js")).href),
);

const targets = [
  { route: "(shell)", indices: [0] },
  ...server.manifest.routes.flatMap(({ id, page }) =>
    page ? [{ route: id, indices: [...page.layouts, page.leaf] }] : [],
  ),
];

for (const { route, indices } of targets) {
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

  const routeNodes = indices.flatMap((index) =>
    index === null ? [] : nodes.filter((name) => name.endsWith(`/nodes/${index}.js`)),
  );

  for (const name of [...shell, ...routeNodes]) visit(name);
  const sizes = { js: 0, css: 0, jsGzip: 0, cssGzip: 0 };

  for (const file of files) {
    const data = await readFile(resolve(directory, file));
    const kind = file.endsWith(".css") ? "css" : "js";
    sizes[kind] += data.byteLength;
    sizes[kind === "css" ? "cssGzip" : "jsGzip"] += gzipSync(data).byteLength;
  }

  console.info(JSON.stringify({ route, nodes: routeNodes, ...sizes }));
}

if (!nodes.length) throw new Error("No SvelteKit nodes found; build the web application first");
