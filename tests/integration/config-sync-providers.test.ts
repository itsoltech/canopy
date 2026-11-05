import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { isBigInt } from "@canopy/testing";
import { Provider, ProviderProfileKind, type ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { configAllowed } from "../../apps/gateway/src/computers/runtime-config.ts";
import { decryptSecret } from "../../apps/gateway/src/store/secrets.ts";
import {
  configComputer,
  createInstance,
  editInstance,
  instanceOf,
  pairConfig,
  secretsOf,
  type ConfigComputer,
} from "./support/config-sync.ts";
import { eventually } from "./support/gateway.ts";

const wait = async (predicate: () => Promise<boolean> | boolean) =>
  expect(await eventually(async () => predicate(), Boolean, 20_000)).toBe(true);

const KEY = "sk-provider-sync-key-5a9f2c1e";
const KEY_A = "sk-changed-on-a-while-apart-71";
const KEY_B = "sk-changed-on-b-while-apart-82";
const ORG = "org-variable-secret-3141592";
const PROXY_SECRET = "proxy-secret-value-2718281";
const SECRETS = [KEY, KEY_A, KEY_B, ORG, PROXY_SECRET];

const json = <T>(value: T) => JSON.stringify(value, (_k, v) => (isBigInt(v) ? v.toString() : v));

const synced = (a: ConfigComputer, b: ConfigComputer) =>
  wait(() => configAllowed(a.links, b.node) && configAllowed(b.links, a.node));

/** Saves a proxy as its form does; the secret stays unless replaced. */
const editProxy = (computer: ConfigComputer, proxy: ui.Proxy, change: { name?: string; secret?: string }) =>
  computer.gateway.api.saveProxy({
    id: proxy.id,
    name: change.name ?? proxy.name,
    kind: proxy.kind,
    baseUrl: proxy.baseUrl,
    codex: proxy.codex,
    expectedRevision: proxy.revision,
    ...(change.secret !== undefined && { secret: change.secret }),
  });

async function profile(computer: ConfigComputer, id: string) {
  return (await eventually(
    async () => computer.gateway.worker.configs.at(-1)?.profiles.find((p) => p.id === id),
    Boolean,
    20_000,
  ))!;
}

describe.skipIf(!dockerAvailable)("provider instances, models and proxies across linked gateways", () => {
  let a: ConfigComputer;
  let b: ConfigComputer;
  const printed: string[] = [];

  const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
    spyOn(console, level).mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(" "));
    }),
  );

  beforeAll(async () => {
    a = await configComputer("Laptop A");
    b = await configComputer("Laptop B");
    await pairConfig(a, b);
    await synced(a, b);
  }, 90_000);
  afterAll(async () => {
    await Promise.allSettled([a?.close(), b?.close()]);

    for (const spy of spies) spy.mockRestore();
  }, 30_000);

  test("a rename on A appears on B, and an edit on B comes back to A", async () => {
    await createInstance(a, {
      harness: Provider.CODEX,
      id: "team",
      label: "Team endpoint",
      kind: ProviderProfileKind.CLIPROXYAPI,
      baseUrl: "http://127.0.0.1:8317",
      apiKey: KEY,
      accentColor: "#7c3aed",
      env: [
        { name: "PROFILE_PROBE", value: "probe-42" },
        { name: "ORG_TOKEN", secret: true, value: ORG },
      ],
      runtime: { binaryPath: "/opt/laptop-a/codex", launchArgs: ["--shared-arg"] },
    });
    await wait(async () => (await instanceOf(b, Provider.CODEX, "team"))?.label === "Team endpoint");
    await editInstance(a, Provider.CODEX, "team", { label: "Team endpoint renamed" });
    await wait(async () => (await instanceOf(b, Provider.CODEX, "team"))?.label === "Team endpoint renamed");
    const onB = (await instanceOf(b, Provider.CODEX, "team"))!;
    expect(onB).toMatchObject({ baseUrl: "http://127.0.0.1:8317", accentColor: "#7c3aed", apiKeySet: true });
    expect(onB.runtime).toMatchObject({ binaryPath: "", launchArgs: ["--shared-arg"] });
    // New variables arrive in name order; each computer keeps its own order afterwards.
    expect(onB.env.map((v) => [v.name, v.secret, v.value])).toEqual([
      ["ORG_TOKEN", true, ""],
      ["PROFILE_PROBE", false, "probe-42"],
    ]);
    await b.gateway.api.setInstanceModels({
      harness: Provider.CODEX,
      id: "team",
      models: { favorites: ["gpt-5.5"], hidden: ["old-model"], custom: ["team-model"] },
    });
    await editInstance(b, Provider.CODEX, "team", { accentColor: "#0ea5e9" });
    await wait(async () => (await instanceOf(a, Provider.CODEX, "team"))?.accentColor === "#0ea5e9");
    await wait(async () => (await instanceOf(a, Provider.CODEX, "team"))?.models?.custom[0] === "team-model");
    expect((await instanceOf(a, Provider.CODEX, "team"))?.models?.favorites).toEqual(["gpt-5.5"]);
    expect((await instanceOf(a, Provider.CODEX, "team"))?.runtime?.binaryPath).toBe("/opt/laptop-a/codex");
    expect((await instanceOf(a, Provider.CODEX, "team"))?.label).toBe("Team endpoint renamed");
  }, 40_000);

  test("keys arrive re-encrypted, run on B's worker and never reach the BFF, history or logs", async () => {
    const config = await profile(b, "team");
    expect(config).toMatchObject({ apiKey: KEY, baseUrl: "http://127.0.0.1:8317" });
    expect(config.env.find((v) => v.name === "ORG_TOKEN")?.value).toBe(ORG);
    expect(config.executablePath).toBe("");

    const plain = (computer: ConfigComputer) =>
      secretsOf(computer).then((rows) =>
        rows.flatMap((r) => {
          try {
            return [{ ...r, plain: decryptSecret(computer.gateway.secretsKey, r.ciphertext) }];
          } catch {
            return [];
          }
        }),
      );

    const onA = (await plain(a)).find((r) => r.plain === KEY)!;
    const onB = (await plain(b)).find((r) => r.plain === KEY)!;
    expect(onB).toBeDefined();
    expect(Buffer.from(onB.ciphertext).equals(Buffer.from(onA.ciphertext))).toBe(false);
    expect(() => decryptSecret(a.gateway.secretsKey, onB.ciphertext)).toThrow();

    const visible = json([
      await b.gateway.api.listProviderInstances({}),
      await b.gateway.api.getComputers({}),
      await b.gateway.api.getOverview({}),
      await b.gateway.api.listProxies({}),
      await b.store.query("SELECT * FROM config_items"),
      await b.store.query("SELECT kind,global_id,field,value,hlc FROM config_history"),
    ]);

    for (const secret of SECRETS) expect(visible).not.toContain(secret);
  }, 30_000);

  test("a proxy rename and its secret follow, and instances keep pointing at it", async () => {
    const proxy = (
      await a.gateway.api.saveProxy({
        name: "Office proxy",
        kind: "cliproxyapi",
        baseUrl: "http://127.0.0.1:8318",
        secret: PROXY_SECRET,
      })
    ).proxy!;

    await editInstance(a, Provider.CODEX, "team", { proxyId: proxy.id });
    await wait(async () => (await instanceOf(b, Provider.CODEX, "team"))?.proxyId === proxy.id);
    await editProxy(a, proxy, { name: "Office proxy renamed" });
    await wait(
      async () =>
        (await b.gateway.api.listProxies({})).proxies.find((p) => p.id === proxy.id)?.name === "Office proxy renamed",
    );
    expect((await profile(b, "team")).apiKey).toBe(PROXY_SECRET);
    await wait(async () => (await profile(b, "team")).baseUrl === "http://127.0.0.1:8318");
    // A direct endpoint becomes a saved proxy on save; B follows the same one.
    await editInstance(a, Provider.CODEX, "team", { proxyId: "", baseUrl: "http://127.0.0.1:8317", apiKey: KEY });
    const direct = (await instanceOf(a, Provider.CODEX, "team"))!.proxyId;
    expect(direct).not.toBe(proxy.id);
    await wait(async () => (await instanceOf(b, Provider.CODEX, "team"))?.proxyId === direct);
    await wait(async () => (await profile(b, "team")).apiKey === KEY);
  }, 30_000);

  test("concurrent edits converge with notices; Restore of a name and a key reaches both", async () => {
    const proxyId = (await instanceOf(a, Provider.CODEX, "team"))!.proxyId;

    const proxyOf = async (computer: ConfigComputer) =>
      (await computer.gateway.api.listProxies({})).proxies.find((p) => p.id === proxyId)!;

    await a.sharing(b.node, false);
    await wait(() => !configAllowed(b.links, a.node));
    await editInstance(a, Provider.CODEX, "team", { label: "Named on A" });
    await editProxy(a, await proxyOf(a), { secret: KEY_A });
    await Bun.sleep(5);
    await editInstance(b, Provider.CODEX, "team", { label: "Named on B" });
    await editProxy(b, await proxyOf(b), { secret: KEY_B });
    await a.sharing(b.node, true);
    await synced(a, b);
    await wait(
      async () =>
        (await instanceOf(a, Provider.CODEX, "team"))?.label === "Named on B" &&
        (await profile(a, "team")).apiKey === KEY_B,
    );
    expect((await instanceOf(b, Provider.CODEX, "team"))?.label).toBe("Named on B");

    const notices = (await a.links.snapshot()).configNotices;
    const label = notices.find((n) => n.kind === "instance" && n.globalId === "codex:team" && n.field === "label")!;
    const key = notices.find((n) => n.kind === "proxy" && n.field === "secret")!;
    expect(JSON.parse(label.value)).toBe("Named on A");
    expect(label).toMatchObject({ localId: "team", itemName: "Named on B", nodeName: "Laptop B" });
    expect(key.value).toBe("A different key");
    expect(json(await a.gateway.api.getComputers({}))).not.toContain(KEY_A);
    await a.gateway.api.manageConfigNotice({ id: label.id, action: "restore" });
    await a.gateway.api.manageConfigNotice({ id: key.id, action: "restore" });
    await wait(async () => (await instanceOf(b, Provider.CODEX, "team"))?.label === "Named on A");
    await wait(async () => (await profile(b, "team")).apiKey === KEY_A);
    expect((await profile(a, "team")).apiKey).toBe(KEY_A);
    expect(json(await a.store.query("SELECT value,hlc FROM config_history"))).not.toContain(KEY_B);
  }, 40_000);

  test("a deletion is a tombstone with Restore on the other computer", async () => {
    await a.gateway.api.deleteProviderInstance({ harness: Provider.CODEX, id: "team" });
    await wait(async () => !(await instanceOf(b, Provider.CODEX, "team")));
    const notice = (await b.links.snapshot()).configNotices.find((n) => n.kind === "instance" && n.field === "deleted");
    expect(notice).toMatchObject({ reason: "deleted", itemName: "Named on A", localId: "" });
    expect((await a.links.snapshot()).configNotices.some((n) => n.field === "deleted")).toBe(false);
    await b.restart();
    await synced(a, b);
    expect(await instanceOf(b, Provider.CODEX, "team")).toBeUndefined();
    await b.gateway.api.manageConfigNotice({ id: notice!.id, action: "restore" });
    await wait(async () => (await instanceOf(a, Provider.CODEX, "team"))?.label === "Named on A");
    expect((await profile(a, "team")).apiKey).toBe(KEY_A);
    expect((await profile(b, "team")).apiKey).toBe(KEY_A);
  }, 40_000);

  test("with sharing off, keys and instances stay on their computer", async () => {
    await b.sharing(a.node, false);
    await wait(() => !configAllowed(a.links, b.node));
    await createInstance(a, {
      harness: Provider.CLAUDE,
      id: "private",
      label: "Private endpoint",
      kind: ProviderProfileKind.CLIPROXYAPI,
      baseUrl: "http://127.0.0.1:8319",
      apiKey: "sk-private-never-leaves-a-999",
    });
    await Bun.sleep(1500);
    expect(await instanceOf(b, Provider.CLAUDE, "private")).toBeUndefined();
    expect(json(await b.store.query("SELECT * FROM config_items"))).not.toContain("private");
    const plain = (await secretsOf(b)).map((r) => decryptSecret(b.gateway.secretsKey, r.ciphertext));
    expect(plain).not.toContain("sk-private-never-leaves-a-999");
    await b.sharing(a.node, true);
    await synced(a, b);
    await wait(async () => !!(await instanceOf(b, Provider.CLAUDE, "private")));
  }, 30_000);

  test("another owner's instances, proxies and records never leave the gateway", async () => {
    const owner = crypto.randomUUID();
    await a.store.query("INSERT INTO users(id,email,display_name,role) VALUES($1::uuid,$2,'Other owner','user')", [
      owner,
      `${owner}@example.test`,
    ]);
    await a.store.query(
      "INSERT INTO provider_instances(harness,id,label,kind,created_by) VALUES('claude','foreign','Foreign instance','native',$1::uuid)",
      [owner],
    );
    await a.store.query(
      `INSERT INTO proxies(id,owner_user_id,name,kind,base_url,fingerprint) VALUES($1::uuid,$2::uuid,'Foreign proxy','openai','http://127.0.0.1:9',
      'x')`,
      [crypto.randomUUID(), owner],
    );
    await editInstance(a, Provider.CLAUDE, "private", { label: "Private endpoint renamed" });
    await wait(async () => (await instanceOf(b, Provider.CLAUDE, "private"))?.label === "Private endpoint renamed");
    const records = json(await b.store.query("SELECT * FROM config_items"));
    expect(records).not.toContain("Foreign");
    expect(json(await a.store.query("SELECT * FROM config_items WHERE owner_user_id=$1::uuid", [owner]))).toBe("[]");
    expect(printed.join("\n")).not.toMatch(new RegExp(SECRETS.join("|")));
  }, 30_000);
});
