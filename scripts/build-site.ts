/**
 * Builds the GitHub Pages site (`site/`) into `dist/site`: the OAuth redirect page with its script inlined
 * and a CSP that allows only that script and style, by hash.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const out = join(root, "dist/site");
const hash = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

const built = await Bun.build({
  entrypoints: [join(root, "site/oauth/callback.ts")],
  target: "browser",
  format: "iife",
  minify: true,
});

if (!built.success) throw new AggregateError(built.logs, "Could not build the OAuth redirect page");

const script = (await built.outputs[0]!.text()).trim();
const template = await readFile(join(root, "site/oauth/callback.html"), "utf8");
const style = /<style>([\s\S]*?)<\/style>/.exec(template)?.[1] ?? "";

const csp = [
  "default-src 'none'",
  `script-src ${hash(script)}`,
  `style-src ${hash(style)}`,
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

// The script is inlined last: replacement patterns like `$&` in minified code must not be expanded.
const page = template.replace("__CSP__", csp).replace("__SCRIPT__", () => script);

await mkdir(join(out, "oauth"), { recursive: true });

await writeFile(join(out, "oauth/callback.html"), page);

// GitHub Pages serves a Jekyll build unless told otherwise.
await writeFile(join(out, ".nojekyll"), "");

console.log(`Built ${join(out, "oauth/callback.html")}`);
