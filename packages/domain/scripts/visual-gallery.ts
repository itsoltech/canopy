import { Result } from "effect";
import { compileVisual, escapeHtml } from "../src/visuals/compile.ts";
import { decodeVisualSpec } from "../src/visuals/spec.ts";
import { visualTheme } from "../src/visuals/theme.ts";
import { catalogue } from "./visual-gallery-fixtures.ts";
import { banking } from "./visual-gallery-banking.ts";

// Development-only fixture server, separate from the app and its authentication. Nothing is emitted by app builds.
const port = Number(process.env["PORT"] ?? 5397);
const documents = new Map<string, string>();
const cards: string[] = [];

for (const [name, spec] of [
  ["Banking and login", banking],
  ["Component catalogue", catalogue],
] as const) {
  const decoded = decodeVisualSpec(JSON.parse(JSON.stringify(spec)));

  if (Result.isFailure(decoded)) throw new Error(decoded.failure);

  for (const mode of ["light", "dark"] as const) {
    for (const width of [360, 960]) {
      const path = `/fixture-${documents.size}`;
      documents.set(
        path,
        compileVisual(decoded.success, {
          title: name,
          mode: "export",
          nonce: "canopy-gallery-preview",
          instance: "gallery",
          theme: visualTheme("birch", mode),
        }),
      );
      cards.push(
        `<section><h2>${escapeHtml(name)} · ${mode} · ${width}px</h2><iframe title="${escapeHtml(name)} ${mode} ${width}px" sandbox="allow-scripts" src="${path}" width="${width}" height="${name === "Component catalogue" ? 2600 : 1250}"></iframe></section>`,
      );
    }
  }
}

const index = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Visual kit gallery</title><style>
body{margin:24px;background:#eceeea;color:#20241e;font:14px/1.5 system-ui}h1{font-size:20px}h2{font-size:14px;font-weight:500}main{display:flex;flex-wrap:wrap;gap:24px;align-items:flex-start}section{max-width:100%;overflow:auto}iframe{display:block;border:1px solid #ccd0c8;border-radius:12px;background:white}
</style><h1>Visual kit gallery</h1><p>Each composition uses the production compiler, sandbox and theme tokens. Scroll each frame to inspect the full catalogue.</p><main>${cards.join("")}</main></html>`;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(request) {
    const path = new URL(request.url).pathname;
    const html = path === "/" ? index : documents.get(path);

    return new Response(html ?? "Not found", {
      status: html ? 200 : 404,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
});

console.log(`Visual kit gallery: ${server.url}`);
