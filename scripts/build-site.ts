/**
 * Publishes the product demo and builds the OAuth client metadata and redirect pages for GitHub Pages.
 * The redirect page has a CSP that allows only its inline script and style, by hash.
 */
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  DEFAULT_OAUTH_REDIRECT_URL,
  OAUTH_CLIENT_METADATA_REDIRECT_URL,
  OAUTH_CLIENT_METADATA_URL,
} from "@canopy/domain/oauth-return";
import { motion, palette } from "@canopy/ui";
import { themeVariables } from "@canopy/ui/themes";

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

const [template, wordmark] = await Promise.all([
  readFile(join(root, "site/oauth/callback.html"), "utf8"),
  readFile(join(root, "design/brand/canopy-wordmark.svg"), "utf8"),
]);

const light = themeVariables("birch", "light");
const dark = themeVariables("birch", "dark");
const surfaces = ["canvas", "surface", "panel", "hover", "ink", "muted"] as const;

const theme = [
  ...surfaces.map((token) => `--${token}: light-dark(${light[token]}, ${dark[token]});`),
  `--accent: light-dark(${palette.emerald[700]}, ${palette.emerald[400]});`,
  `--on-accent: light-dark(#fff, ${dark.canvas});`,
  `--duration-fast: ${motion.fast}ms;`,
  `--ease-smooth-out: cubic-bezier(${motion.smoothOut.join(", ")});`,
].join("\n        ");

// Hash the final inline script and style, including indentation, as the browser does. Function replacements
// keep literal patterns such as `$&` in the minified script.
const inlined = template
  .replace("__SCRIPT__", () => script)
  .replace("/* __THEME__ */", () => theme)
  .replace("__WORDMARK__", () => wordmark.trim());

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

const callbackFile = (url: string) => join(out, "oauth", `${basename(new URL(url).pathname)}.html`);

await writeFile(callbackFile(DEFAULT_OAUTH_REDIRECT_URL), page.replace("<body>", "<body data-web-return>"));

await writeFile(callbackFile(OAUTH_CLIENT_METADATA_REDIRECT_URL), page);

const metadata = {
  client_id: OAUTH_CLIENT_METADATA_URL,
  client_name: "Canopy",
  redirect_uris: [OAUTH_CLIENT_METADATA_REDIRECT_URL],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};

const metadataFile = basename(new URL(OAUTH_CLIENT_METADATA_URL).pathname);

await writeFile(join(out, "oauth", metadataFile), `${JSON.stringify(metadata, null, 2)}\n`);

await cp(join(root, "site/demo"), join(out, "demo"), { recursive: true });

// GitHub Pages serves a Jekyll build unless told otherwise.
await writeFile(join(out, ".nojekyll"), "");

console.log(`Built ${join(out, "oauth/callback.html")}`);
