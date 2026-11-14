import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The binary and image gateways run the web BFF in their own process (apps/gateway/src/web/server.ts), so the
 * BFF sees the gateway's environment. It must keep reading only its declared settings (`$app/env/private`,
 * apps/web/src/env.ts): never the gateway's database URL, secrets key or TLS key, and never the whole private
 * environment through SvelteKit's `$env/*` modules.
 */
const web = join(import.meta.dir, "../../apps/web/src");

const forbidden = [
  "CANOPY_DATABASE_URL",
  "CANOPY_SECRETS_KEY",
  "CANOPY_TLS_KEY",
  "$env/dynamic/private",
  "$env/static/private",
];

test("web BFF source never reads gateway secrets", () => {
  const files = readdirSync(web, { recursive: true, encoding: "utf8" }).filter((file) =>
    /\.(ts|svelte|js)$/.test(file),
  );

  const hits = files.flatMap((file) => {
    const text = readFileSync(join(web, file), "utf8");

    return forbidden.flatMap((name) => (text.includes(name) ? [`${file}: ${name}`] : []));
  });

  expect(files.length).toBeGreaterThan(100);
  expect(hits).toEqual([]);
});
