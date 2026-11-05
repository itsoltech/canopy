import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const hash = (text: string) => `sha256-${createHash("sha256").update(text).digest("base64")}`;

// The redirect page's CSP allows inline code only by hash. A hash of anything but the exact text between the tags
// makes the browser block the script, and sign-in then stops on "Returning to Canopy…".
test("the built OAuth redirect page allows exactly its inline script and style", async () => {
  const build = Bun.spawnSync(["bun", join(root, "scripts/build-site.ts")], { cwd: root });
  expect(build.exitCode).toBe(0);
  const page = await readFile(join(root, "dist/site/oauth/callback.html"), "utf8");
  const policy = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(page)?.[1] ?? "";

  for (const [tag, directive] of [
    ["script", "script-src"],
    ["style", "style-src"],
  ] as const) {
    const body = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(page)?.[1];
    expect(body).toBeDefined();
    expect(policy).toContain(`${directive} '${hash(body!)}'`);
  }
});
