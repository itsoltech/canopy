import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { configComputer, editInstance, instanceOf, pairConfig, type ConfigComputer } from "./support/config-sync.ts";
import { eventually } from "./support/gateway.ts";

const wait = async (predicate: () => Promise<boolean>) =>
  expect(await eventually(predicate, Boolean, 20_000)).toBe(true);

describe.skipIf(!dockerAvailable)("stale configuration notices reconcile with current values", () => {
  let a: ConfigComputer;
  let b: ConfigComputer;

  beforeAll(async () => {
    a = await configComputer("Computer A");
    b = await configComputer("Computer B");
    await pairConfig(a, b);
    await wait(async () => (await a.links.snapshot()).configGroup.length === 2);
  }, 90_000);
  afterAll(async () => {
    await Promise.allSettled([a?.close(), b?.close()]);
  }, 30_000);

  test("one divergent field produces one notice, then clears when its old value becomes current", async () => {
    await a.sharing(b.node, false);
    await wait(async () => !(await b.store.peer(a.node))?.peer_share_config);
    await editInstance(a, Provider.CLAUDE, "native", { label: "Name A" });
    await editInstance(b, Provider.CLAUDE, "native", { label: "Name B" });
    await a.sharing(b.node, true);
    await wait(
      async () =>
        (await a.links.snapshot()).configNotices.length === 1 && (await b.links.snapshot()).configNotices.length === 1,
    );

    for (const computer of [a, b]) {
      const notices = (await computer.links.snapshot()).configNotices;
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ kind: "instance", field: "label", reason: "choice" });
    }

    const old = JSON.parse((await a.links.snapshot()).configNotices[0]!.value);
    await editInstance(a, Provider.CLAUDE, "native", { label: old });
    await wait(async () => (await instanceOf(b, Provider.CLAUDE, "native"))?.label === old);

    await wait(
      async () =>
        (await a.links.snapshot()).configNotices.length === 0 && (await b.links.snapshot()).configNotices.length === 0,
    );
  }, 40_000);

  test("equal notices left by older releases clear automatically and remain handled after restart", async () => {
    await a.store.query(
      `INSERT INTO config_history(owner_user_id,kind,global_id,field,value,hlc,node_id,notice_node_id,reason)
      SELECT owner_user_id,kind,global_id,f.key,f.value->'value',f.value->>'hlc',$2,$2,'merged'
      FROM config_items CROSS JOIN LATERAL jsonb_each(fields) f
      WHERE owner_user_id=$1::uuid AND kind='settings' ON CONFLICT DO NOTHING`,
      [a.gateway.userId, b.node],
    );
    expect((await a.links.snapshot()).configNotices).toEqual([]);
    const states = await a.store.query<{ state: string }>("SELECT state FROM config_history WHERE kind='settings'");
    expect(states.length).toBeGreaterThan(10);
    expect(states.every((s) => s.state === "dismissed")).toBe(true);
    await a.restart();
    expect((await a.links.snapshot()).configNotices).toEqual([]);
  }, 40_000);

  test("a secret notice clears when its plaintext is restored under a new token and ciphertext", async () => {
    await wait(async () => (await a.links.snapshot()).configGroup.length === 2);
    await a.sharing(b.node, false);
    await wait(async () => !(await b.store.peer(a.node))?.peer_share_config);
    await editInstance(a, Provider.CLAUDE, "native", {
      env: [{ name: "FIXTURE_SECRET", secret: true, value: "fixture-value-a" }],
    });
    await editInstance(b, Provider.CLAUDE, "native", {
      env: [{ name: "FIXTURE_SECRET", secret: true, value: "fixture-value-b" }],
    });
    await a.sharing(b.node, true);
    await wait(
      async () =>
        (await a.links.snapshot()).configNotices.length === 1 && (await b.links.snapshot()).configNotices.length === 1,
    );
    expect((await a.links.snapshot()).configNotices[0]?.value).toBe("A different key");

    const [lost] = await a.store.query<{ node_id: string }>(
      "SELECT node_id FROM config_history WHERE state='open' AND field='env.FIXTURE_SECRET'",
    );

    expect([a.node, b.node]).toContain(lost!.node_id);
    await editInstance(a, Provider.CLAUDE, "native", {
      env: [
        {
          name: "FIXTURE_SECRET",
          secret: true,
          value: lost!.node_id === a.node ? "fixture-value-a" : "fixture-value-b",
        },
      ],
    });
    await wait(
      async () =>
        (await a.links.snapshot()).configNotices.length === 0 && (await b.links.snapshot()).configNotices.length === 0,
    );
  }, 40_000);
});
