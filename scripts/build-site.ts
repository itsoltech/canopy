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

// The script is inlined first (replacement patterns like `$&` in minified code must not be expanded), then the CSP
// hashes the exact text between the tags, including the template's indentation, as the browser does.
const inlined = template.replace("__SCRIPT__", () => script);

const body = (tag: string) => {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(inlined);

  if (!match) throw new Error(`The OAuth redirect page has no <${tag}>`);

  return match[1]!;
};

const csp = [
  "default-src 'none'",
  `script-src ${hash(body("script"))}`,
  `style-src ${hash(body("style"))}`,
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const page = inlined.replace("__CSP__", csp);

await mkdir(join(out, "oauth"), { recursive: true });

await writeFile(join(out, "oauth/callback.html"), page);

// GitHub Pages serves a Jekyll build unless told otherwise.
await writeFile(join(out, ".nojekyll"), "");

console.log(`Built ${join(out, "oauth/callback.html")}`);
