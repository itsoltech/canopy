/**
 * Publishes the product demo and builds the OAuth client metadata and redirect pages for GitHub Pages.
 * The redirect page has a CSP that allows only its inline script and style, by hash.
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  DEFAULT_OAUTH_REDIRECT_URL,
  OAUTH_CLIENT_METADATA_REDIRECT_URL,
  OAUTH_CLIENT_METADATA_URL,
} from "@canopy/domain/oauth-return";

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

await mkdir(join(out, "demo"), { recursive: true });

await copyFile(join(root, "site/demo/canopy-demo.mp4"), join(out, "demo/canopy-demo.mp4"));

// GitHub Pages serves a Jekyll build unless told otherwise.
await writeFile(join(out, ".nojekyll"), "");

console.log(`Built ${join(out, "oauth/callback.html")}`);
