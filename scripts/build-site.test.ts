import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { OAUTH_CLIENT_METADATA_REDIRECT_URL, OAUTH_CLIENT_METADATA_URL } from "@canopy/domain/oauth-return";

const root = join(import.meta.dir, "..");
const hash = (text: string) => `sha256-${createHash("sha256").update(text).digest("base64")}`;

// The redirect page's CSP allows inline code only by hash. A hash of anything but the exact text between the tags
// makes the browser block the script, and sign-in then stops on "Returning to Canopy…".
test("the OAuth site publishes the client metadata and the redirect with its exact CSP hashes", async () => {
  const build = Bun.spawnSync(["bun", join(root, "scripts/build-site.ts")], { cwd: root });
  expect(build.exitCode).toBe(0);
  const page = await readFile(join(root, "dist/site/oauth/callback.html"), "utf8");
  const policy = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(page)?.[1] ?? "";

  const metadataPath = new URL(OAUTH_CLIENT_METADATA_URL).pathname.replace(/^\/canopy\//, "");
  const metadata = await Bun.file(join(root, "dist/site", metadataPath)).json();
  expect(metadata).toEqual({
    client_id: OAUTH_CLIENT_METADATA_URL,
    client_name: "Canopy",
    redirect_uris: [OAUTH_CLIENT_METADATA_REDIRECT_URL],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
  const redirectPath = new URL(OAUTH_CLIENT_METADATA_REDIRECT_URL).pathname.replace(/^\/canopy\//, "");
  const sharedPage = await readFile(join(root, "dist/site", `${redirectPath}.html`), "utf8");
  expect(page).toContain("<body data-web-return>");
  expect(sharedPage).not.toContain("data-web-return>");

  for (const [tag, directive] of [
    ["script", "script-src"],
    ["style", "style-src"],
  ] as const) {
    const body = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(page)?.[1];
    expect(body).toBeDefined();
    expect(policy).toContain(`${directive} '${hash(body!)}'`);
  }
});
