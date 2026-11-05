import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toJsonString } from "@bufbuild/protobuf";
import { ProviderAccountStatusSchema } from "@canopy/contracts";
import { AccountStatuses, type AccountQuery } from "../../apps/worker/src/providers/account-status.ts";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function fixture(harness: AccountQuery["harness"], mode = "ok", timeout = 2_000) {
  const dir = await mkdtemp(join(tmpdir(), "canopy-accounts-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "cli.ts");
  await writeFile(
    file,
    `
import { appendFileSync } from "node:fs";
appendFileSync(process.env.COUNT_FILE!, "x");
const mode = process.env.FAKE_MODE;
if (mode === "timeout") { setInterval(() => {}, 1000); await new Promise(() => {}); }
if (mode === "delay") await Bun.sleep(100);
const args = process.argv.slice(2).join(" ");
if (args === "auth status --json") {
  if (mode === "malformed") console.log("not json " + process.env.FAKE_SECRET);
  else console.log(JSON.stringify({ loggedIn: mode !== "out", authMethod: "claude.ai", email: "qa@example.test", orgName: mode === "secret" ? process.env.FAKE_SECRET : "Example team", subscriptionType: "team", loginExpiresAt: "2030-11-22T10:00:00Z", orgId: "private-org-id", accessToken: process.env.FAKE_SECRET, config: process.env.CLAUDE_CONFIG_DIR }));
  process.exit(mode === "out" ? 1 : 0);
}
if (args === "login status") {
  console.error(mode === "out" ? "Not logged in" : mode === "key" ? "API key configured - " + process.env.FAKE_SECRET : mode === "malformed" ? process.env.FAKE_SECRET : "Logged in using ChatGPT");
  process.exit(mode === "out" ? 1 : 0);
}
throw new Error("Unexpected fake CLI invocation");
`,
    { mode: 0o600 },
  );
  const statuses = new AccountStatuses(timeout);
  cleanups.push(() => statuses.close());

  const query: AccountQuery = {
    harness,
    id: "native",
    executable: process.execPath,
    args: [file],
    configDir: dir,
    configVersion: 1n,
    secrets: ["fixture-secret-value"],
    env: {
      ...process.env,
      COUNT_FILE: join(dir, "count"),
      FAKE_MODE: mode,
      FAKE_SECRET: "fixture-secret-value",
      CLAUDE_CONFIG_DIR: dir,
      CODEX_HOME: dir,
    },
  };

  return { statuses, query, count: async () => (await readFile(join(dir, "count"), "utf8")).length };
}

describe("official CLI account adapters", () => {
  test("Claude returns only display metadata; Codex text is enriched through its existing account API; Grok launches nothing", async () => {
    const claude = await fixture("claude");
    const status = await claude.statuses.read(claude.query);
    expect(status).toMatchObject({
      state: "signed_in",
      email: "qa@example.test",
      organization: "Example team",
      plan: "team",
      configDir: claude.query.configDir,
    });
    const codex = await fixture("codex");
    let calls = 0;
    codex.query.codexMetadata = async () => {
      calls++;

      return { email: "qa@example.test", plan: "plus" };
    };

    expect(await codex.statuses.read(codex.query)).toMatchObject({
      state: "signed_in",
      authMethod: "ChatGPT",
      plan: "plus",
      email: "qa@example.test",
    });
    await codex.statuses.read(codex.query);
    expect(calls).toBe(1);
    const grok = await fixture("grok");
    expect(await grok.statuses.read(grok.query)).toMatchObject({ state: "unknown", email: "", detail: "" });
    await expect(grok.count()).rejects.toThrow();
    const json = toJsonString(ProviderAccountStatusSchema, status);
    expect(json).not.toContain("fixture-secret-value");
    expect(json).not.toContain("private-org-id");
    expect(json).not.toContain("accessToken");
  });

  test("cache and forced refresh single-flight per instance, isolate configurations, and invalidate after login", async () => {
    const f = await fixture("claude", "delay");
    const burst = await Promise.all(Array.from({ length: 30 }, () => f.statuses.read(f.query, true)));
    expect(burst.every((s) => s.state === "signed_in")).toBe(true);
    expect(await f.count()).toBe(1);
    await f.statuses.read(f.query);
    expect(await f.count()).toBe(1);
    await Promise.all([f.statuses.read(f.query, true), f.statuses.read(f.query, true)]);
    expect(await f.count()).toBe(2);
    await f.statuses.read({ ...f.query, id: "other" });
    await f.statuses.read({ ...f.query, configVersion: 2n });
    expect(await f.count()).toBe(4);
    f.statuses.invalidate();
    await f.statuses.read(f.query);
    expect(await f.count()).toBe(5);
  });

  for (const harness of ["claude", "codex", "grok"] as const) {
    test(`${harness}: malformed output, signed-out and deadline never forward raw output`, async () => {
      for (const mode of ["malformed", "out", "timeout"]) {
        const f = await fixture(harness, mode, mode === "timeout" ? 200 : 2_000);
        const status = await f.statuses.read(f.query);
        expect(status.state).toBe(harness === "grok" ? "unknown" : mode === "out" ? "signed_out" : "error");
        expect(toJsonString(ProviderAccountStatusSchema, status)).not.toContain("fixture-secret-value");
      }
    });
  }

  test("keys and proxy instances never expose credentials or pretend to be subscription accounts", async () => {
    const codex = await fixture("codex", "key");
    expect(await codex.statuses.read(codex.query)).toMatchObject({
      state: "signed_in",
      authMethod: "API key",
      email: "",
    });
    const claude = await fixture("claude", "secret");
    expect((await claude.statuses.read(claude.query)).organization).toBe("");
    const proxy = await fixture("claude");
    proxy.query.proxy = { name: "Office", configured: true };
    expect(await proxy.statuses.read(proxy.query)).toMatchObject({
      state: "signed_in",
      authMethod: "Proxy",
      proxyName: "Office",
      email: "",
    });
    await expect(proxy.count()).rejects.toThrow();
  });
});
