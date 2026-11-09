import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PermissionMode, Provider, ProviderProfileKind } from "@canopy/contracts";
import { nodeRef } from "@canopy/domain/computers";
import { dockerAvailable } from "@canopy/db/testing";
import { configAllowed } from "../../apps/gateway/src/computers/runtime-config.ts";
import { decryptSecret } from "../../apps/gateway/src/store/secrets.ts";
import {
  configComputer,
  createInstance,
  instanceOf,
  pairConfig,
  secretsOf,
  type ConfigComputer,
} from "./support/config-sync.ts";
import { eventually, failure } from "./support/gateway.ts";

const wait = async (predicate: () => Promise<boolean> | boolean) =>
  expect(await eventually(async () => predicate(), Boolean, 25_000)).toBe(true);

const SHARED = "sk-same-proxy-secret-on-both-11";
const KEY_A = "sk-team-account-of-a-22";
const KEY_B = "sk-team-account-of-b-33";
const KEY_C = "sk-work-computer-only-44";

const own = async (computer: ConfigComputer) =>
  (await computer.gateway.api.listProviderInstances({})).instances
    .filter((i) => !i.builtIn)
    .map((i) => i.id)
    .sort();

const proxy = (computer: ConfigComputer, name: string, secret: string, url = "http://127.0.0.1:8400") =>
  computer.gateway.api.saveProxy({ name, kind: "cliproxyapi", baseUrl: url, secret }).then((r) => r.proxy!);

describe.skipIf(!dockerAvailable)("identity merge, aliases and routed instance ids", () => {
  let a: ConfigComputer;
  let b: ConfigComputer;
  let c: ConfigComputer;
  let project = "";
  let workspace = "";

  beforeAll(async () => {
    a = await configComputer("Laptop A");
    b = await configComputer("Laptop B");
    c = await configComputer("Work computer");
    const onA = await proxy(a, "Proxy on A", SHARED);
    await createInstance(a, {
      harness: Provider.CODEX,
      id: "work",
      label: "Work",
      kind: ProviderProfileKind.CLIPROXYAPI,
      proxyId: onA.id,
    });
    await createInstance(a, {
      harness: Provider.CODEX,
      id: "team",
      label: "Team on A",
      kind: ProviderProfileKind.CLIPROXYAPI,
      baseUrl: "http://127.0.0.1:8401",
      apiKey: KEY_A,
    });
    await Bun.sleep(5);
    const onB = await proxy(b, "Proxy on B", SHARED);
    await createInstance(b, {
      harness: Provider.CODEX,
      id: "office",
      label: "Office",
      kind: ProviderProfileKind.CLIPROXYAPI,
      proxyId: onB.id,
    });
    await createInstance(b, {
      harness: Provider.CODEX,
      id: "team",
      label: "Team on B",
      kind: ProviderProfileKind.CLIPROXYAPI,
      baseUrl: "http://127.0.0.1:8401",
      apiKey: KEY_B,
    });
    await createInstance(c, {
      harness: Provider.CODEX,
      id: "workonly",
      label: "Work only",
      kind: ProviderProfileKind.CLIPROXYAPI,
      baseUrl: "http://127.0.0.1:8402",
      apiKey: KEY_C,
    });
    project = (await b.gateway.api.createProject({ name: "Project on B" })).project!.id;
    workspace = (
      await b.gateway.api.createWorkspace({ projectId: project, workerId: b.gateway.workerId, rootPath: "/repo/b" })
    ).workspace!.id;
    await pairConfig(a, b);
    await pairConfig(b, c, true, false);
    await wait(() => configAllowed(a.links, b.node) && b.links.reachable().includes(c.node));
  }, 120_000);
  afterAll(async () => {
    await Promise.allSettled([a?.close(), b?.close(), c?.close()]);
  }, 30_000);

  test("the same endpoint and key become one instance; another key under one id stays two", async () => {
    await wait(async () => (await own(a)).length === 3 && (await own(b)).length === 3);
    const [onA, onB] = [await own(a), await own(b)];
    expect(onA.filter((id) => id === "work" || id === "team")).toEqual(["team", "work"]);
    expect(onB.filter((id) => id === "office" || id === "team")).toEqual(["office", "team"]);
    // Two accounts under one id: B's keeps its id there and gets a global one; A's arrives on B as team-2.
    const split = onA.find((id) => id.startsWith("team-"))!;
    expect(split).toBe(`team-${b.node.slice(0, 8)}`);
    expect(onB).toContain("team-2");
    expect((await instanceOf(a, Provider.CODEX, split))?.label).toBe("Team on B");
    expect((await instanceOf(b, Provider.CODEX, "team"))?.label).toBe("Team on B");
    expect((await instanceOf(b, Provider.CODEX, "team-2"))?.label).toBe("Team on A");
    await wait(async () =>
      (await a.links.snapshot()).configNotices.some((n) => n.kind === "instance" && n.field === "label"),
    );

    const name = (await a.links.snapshot()).configNotices.find(
      (n) => n.kind === "instance" && n.field === "label" && n.reason === "choice",
    )!;

    await a.gateway.api.manageConfigNotice({ id: name.id, action: "restore" });
    await wait(async () => (await instanceOf(a, Provider.CODEX, "work"))?.label === "Office");
    expect((await instanceOf(b, Provider.CODEX, "office"))?.label).toBe("Office");

    const aliases = await a.store.query<{ alias_id: string; global_id: string }>(
      "SELECT alias_id,global_id FROM config_aliases WHERE kind='instance'",
    );

    expect(aliases).toEqual([{ alias_id: "codex:work", global_id: "codex:office" }]);
    expect((await a.gateway.api.listProxies({})).proxies.filter((p) => p.baseUrl.endsWith(":8400"))).toHaveLength(1);
    expect((await b.gateway.api.listProxies({})).proxies.filter((p) => p.baseUrl.endsWith(":8400"))).toHaveLength(1);

    // Both team accounts run where they belong: each computer has both keys, its own under its own id.
    const keys = async (computer: ConfigComputer) =>
      (await secretsOf(computer)).map((r) => decryptSecret(computer.gateway.secretsKey, r.ciphertext));

    expect(await keys(a)).toEqual(expect.arrayContaining([KEY_A, KEY_B, SHARED]));
    expect(await keys(b)).toEqual(expect.arrayContaining([KEY_A, KEY_B, SHARED]));
  }, 40_000);

  test("a restart keeps one element per identity and adds no notices", async () => {
    const before = (await a.links.snapshot()).configNotices.length;
    await a.restart();
    await wait(() => configAllowed(a.links, b.node));
    await Bun.sleep(1500);
    expect((await own(a)).length).toBe(3);
    expect((await own(b)).length).toBe(3);
    expect((await a.links.snapshot()).configNotices.length).toBe(before);
  }, 40_000);

  test("a thread from A on B's worker uses A's instance id, which B knows by its own", async () => {
    const created = (
      await a.gateway.api.createThread({
        projectId: `${project}~${nodeRef(b.node)}`,
        workspaceId: `${workspace}~${nodeRef(b.node)}`,
        title: "From A",
        provider: Provider.CODEX,
        providerProfileId: "work",
        permissionMode: PermissionMode.ASK,
        clientRequestId: crypto.randomUUID(),
      })
    ).thread!;

    expect(created.providerProfileId).toBe("work");

    const stored = await b.store.query<{ provider_profile_id: string }>(
      "SELECT provider_profile_id FROM threads WHERE id=$1::uuid",
      [created.id.split("~")[0]],
    );

    expect(stored[0]?.provider_profile_id).toBe("office");
  }, 30_000);

  test("over a link without Share configuration nothing is translated and keys stay home", async () => {
    expect(configAllowed(c.links, b.node)).toBe(false);
    expect(await instanceOf(b, Provider.CODEX, "workonly")).toBeUndefined();
    expect(JSON.stringify(await b.store.query("SELECT kind,global_id,fields FROM config_items"))).not.toContain(
      "workonly",
    );

    const keys = (await secretsOf(b)).map((r) => decryptSecret(b.gateway.secretsKey, r.ciphertext));
    expect(keys).not.toContain(KEY_C);

    const thread = (
      await c.gateway.api.createThread({
        projectId: `${project}~${nodeRef(b.node)}`,
        workspaceId: `${workspace}~${nodeRef(b.node)}`,
        title: "From the work computer",
        provider: Provider.CODEX,
        providerProfileId: "office",
        permissionMode: PermissionMode.ASK,
        clientRequestId: crypto.randomUUID(),
      })
    ).thread!;

    expect(thread.providerProfileId).toBe("office");

    expect(
      await failure(
        c.gateway.api.createThread({
          projectId: `${project}~${nodeRef(b.node)}`,
          workspaceId: `${workspace}~${nodeRef(b.node)}`,
          title: "Wrong instance",
          provider: Provider.CODEX,
          providerProfileId: "workonly",
          permissionMode: PermissionMode.ASK,
          clientRequestId: crypto.randomUUID(),
        }),
      ),
    ).toContain("This instance isn't on “Laptop B”. Choose one of its instances.");
  }, 30_000);
});
