import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Provider, ProviderProfileKind } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { configAllowed } from "../../apps/gateway/src/computers/runtime-config.ts";
import { configComputer, editInstance, instanceOf, pairConfig, type ConfigComputer } from "./support/config-sync.ts";
import { eventually } from "./support/gateway.ts";

const wait = async (predicate: () => Promise<boolean> | boolean) =>
  expect(await eventually(async () => predicate(), Boolean, 20_000)).toBe(true);

const PROXY_SECRET = "proxy-secret-connection-5512";
const KEY = "sk-connection-endpoint-7781";

const grokNotices = async (computer: ConfigComputer) =>
  (await computer.links.snapshot()).configNotices.filter((n) => n.kind === "instance" && n.globalId === "grok:native");

const grok = (computer: ConfigComputer) => instanceOf(computer, Provider.GROK, "native");

async function profile(computer: ConfigComputer) {
  return computer.gateway.worker.configs
    .at(-1)
    ?.profiles.find((p) => p.id === "native" && p.providers.includes(Provider.GROK));
}

/** Endpoint through the proxy on both computers, and the workers got its address. */
async function throughProxy(computers: ConfigComputer[], proxyId: string) {
  for (const computer of computers) {
    await wait(async () => (await grok(computer))?.proxyId === proxyId);
    expect((await grok(computer))?.kind).toBe(ProviderProfileKind.CLIPROXYAPI);
    await wait(async () => (await profile(computer))?.baseUrl === "http://127.0.0.1:8318");
  }
}

describe.skipIf(!dockerAvailable)("an instance connection changed on two computers", () => {
  let a: ConfigComputer;
  let b: ConfigComputer;
  let proxyId = "";

  beforeAll(async () => {
    a = await configComputer("Laptop A");
    b = await configComputer("Studio B");
    proxyId = (
      await a.gateway.api.saveProxy({
        name: "Office proxy",
        kind: "cliproxyapi",
        baseUrl: "http://127.0.0.1:8318",
        secret: PROXY_SECRET,
      })
    ).proxy!.id;
    await editInstance(a, Provider.GROK, "native", { kind: ProviderProfileKind.CLIPROXYAPI, proxyId });
    await editInstance(b, Provider.GROK, "native", {
      kind: ProviderProfileKind.CLIPROXYAPI,
      baseUrl: "http://127.0.0.1:9911",
      apiKey: KEY,
    });
    await editInstance(b, Provider.GROK, "native", { kind: ProviderProfileKind.NATIVE, baseUrl: "", proxyId: "" });
    await pairConfig(a, b);
    await wait(() => configAllowed(a.links, b.node) && configAllowed(b.links, a.node));
  }, 90_000);
  afterAll(async () => {
    await Promise.allSettled([a?.close(), b?.close()]);
  }, 30_000);

  test("kind and proxy are one choice; using the other's reaches both computers", async () => {
    await wait(async () => (await grokNotices(b)).length > 0);
    const notices = await grokNotices(b);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ field: "connection", reason: "choice", nodeName: "Laptop A", ownValue: false });
    expect(JSON.parse(notices[0]!.value)).toEqual({ kind: "endpoint", proxy: proxyId });
    expect((await grok(b))?.kind).toBe(ProviderProfileKind.NATIVE);

    await b.gateway.api.manageConfigNotice({ id: notices[0]!.id, action: "restore" });
    await throughProxy([a, b], proxyId);
    await wait(async () => (await grokNotices(a)).length === 0 && (await grokNotices(b)).length === 0);
    expect((await profile(b))?.apiKey).toBe(PROXY_SECRET);
  }, 40_000);

  test("Restore brings back this computer's connection replaced at linking; Keep current leaves it", async () => {
    await editInstance(a, Provider.GROK, "native", { kind: ProviderProfileKind.NATIVE, baseUrl: "", proxyId: "" });
    await wait(async () => (await grok(b))?.kind === ProviderProfileKind.NATIVE && !(await grok(b))?.proxyId);
    await wait(async () => !(await profile(a))?.baseUrl);

    const [record] = await a.store.query<{ proxy: string }>(
      "SELECT fields->'proxy'->>'value' AS proxy FROM config_items WHERE owner_user_id=$1::uuid AND kind='proxy' AND local_id=$2",
      [a.gateway.userId, proxyId],
    );

    // The values an earlier link replaced: written on A, kept in A's history as "merged" with B.
    const lose = (hlc: string) =>
      a.store.query(
        `INSERT INTO config_history(owner_user_id,kind,global_id,field,value,hlc,node_id,notice_node_id,reason)
          VALUES ($1::uuid,'instance','grok:native','kind','"endpoint"'::jsonb,$2,$3,$4,'merged'),
            ($1::uuid,'instance','grok:native','proxy',to_jsonb($5::text),$2,$3,$4,'merged')`,
        [a.gateway.userId, hlc, a.node, b.node, record?.proxy ?? proxyId],
      );

    await lose(`${Date.now() - 60_000}.0.${a.node}`);
    const [merged, ...rest] = await grokNotices(a);
    expect(rest).toHaveLength(0);
    expect(merged).toMatchObject({ field: "connection", reason: "merged", nodeName: "Studio B", ownValue: true });

    await a.gateway.api.manageConfigNotice({ id: merged!.id, action: "restore" });
    await throughProxy([a, b], proxyId);
    await wait(async () => (await grokNotices(a)).length === 0 && (await grokNotices(b)).length === 0);

    await editInstance(a, Provider.GROK, "native", { kind: ProviderProfileKind.NATIVE, baseUrl: "", proxyId: "" });
    await wait(async () => (await grok(b))?.kind === ProviderProfileKind.NATIVE);
    await lose(`${Date.now() - 30_000}.0.${a.node}`);
    const [kept] = await grokNotices(a);
    await a.gateway.api.manageConfigNotice({ id: kept!.id, action: "dismiss" });
    expect(await grokNotices(a)).toHaveLength(0);
    expect((await grok(a))?.kind).toBe(ProviderProfileKind.NATIVE);
    expect((await grok(b))?.kind).toBe(ProviderProfileKind.NATIVE);
  }, 60_000);
});
