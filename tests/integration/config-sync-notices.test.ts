import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { computerLink as link, Provider, ProviderProfileKind } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { wireItem } from "../../apps/gateway/src/config-sync/merge.ts";
import { emptyRecord, type ConfigRow } from "../../apps/gateway/src/config-sync/persistence.ts";
import { secretsOf } from "./support/config-sync.ts";
import { configComputer, editInstance, pairConfig, type ConfigComputer } from "./support/config-sync.ts";
import { eventually } from "./support/gateway.ts";

const wait = async (predicate: () => Promise<boolean>) =>
  expect(await eventually(predicate, Boolean, 20_000)).toBe(true);

describe.skipIf(!dockerAvailable)("configuration notices compare effective values", () => {
  let a: ConfigComputer;
  let b: ConfigComputer;

  beforeAll(async () => {
    a = await configComputer("Computer A");
    b = await configComputer("Computer B");

    for (const computer of [a, b]) {
      await computer.update({
        timezone: "Europe/Warsaw",
        ...(computer === a && { general: { confirmDelete: true }, cliUpdates: { intervalMinutes: 360 } }),
      });
      await editInstance(computer, Provider.CLAUDE, "native", {
        label: "Proxy",
        kind: ProviderProfileKind.CLIPROXYAPI,
        baseUrl: "http://127.0.0.1:18317",
        apiKey: "fixture-identical-key",
        env: [{ name: "FIXTURE_SECRET", secret: true, value: "fixture-identical-env" }],
      });
    }

    await pairConfig(a, b);
    await wait(async () => (await a.links.snapshot()).configGroup.length === 2);
    await wait(async () => (await b.links.snapshot()).configGroup.length === 2);
    await wait(async () => {
      const fields = async (computer: ConfigComputer) =>
        computer.store.query("SELECT fields FROM config_items WHERE kind='instance' AND global_id='claude:native'");

      return JSON.stringify(await fields(a)) === JSON.stringify(await fields(b));
    });
  }, 90_000);
  afterAll(async () => {
    await Promise.allSettled([a?.close(), b?.close()]);
  }, 30_000);

  test("identical settings, proxy keys and environment secrets produce no notices", async () => {
    for (const computer of [a, b]) {
      expect(
        await computer.store.query("SELECT id FROM config_history WHERE kind NOT IN ('worker','computer')"),
      ).toEqual([]);
      expect((await computer.links.snapshot()).configNotices).toEqual([]);
    }

    const onA = await secretsOf(a);
    const onB = await secretsOf(b);
    expect(onA.length).toBeGreaterThan(0);
    expect(onB.length).toBeGreaterThan(0);
    expect(onA.some((x) => onB.some((y) => Buffer.from(x.ciphertext).equals(Buffer.from(y.ciphertext))))).toBe(false);
  });

  test("an edit and a restart do not manufacture differences", async () => {
    await a.update({ timezone: "Asia/Tokyo" });
    await wait(async () => (await b.settings()).timezone === "Asia/Tokyo");
    await b.restart();
    await wait(async () => (await b.links.snapshot()).configGroup.length === 2);

    for (const computer of [a, b]) expect((await computer.links.snapshot()).configNotices).toEqual([]);
  }, 40_000);

  test("version skew and tied HLC wall times preserve equal JSON values; routes stay local", async () => {
    const nodes = [a.node, b.node].sort();
    const wall = Date.now() + 1000;
    const row = emptyRecord("future_kind", "equal-future");
    row.schema_version = 2;
    row.fields["choice"] = { value: { first: 1, second: 2 }, hlc: `${wall}.0.${nodes[0]}`, prev: "" };
    await a.links.config!.receive(b.node, create(link.ConfigUpdateSchema, { items: [wireItem(row)] }), () => true);
    row.fields["choice"] = { value: { second: 2, first: 1 }, hlc: `${wall}.0.${nodes[1]}`, prev: "" };
    await a.links.config!.receive(b.node, create(link.ConfigUpdateSchema, { items: [wireItem(row)] }), () => true);
    const stored = (await a.store.query<ConfigRow>("SELECT * FROM config_items WHERE kind='future_kind'"))[0]!;
    expect(stored.schema_version).toBe(2);
    expect(stored.unsupported).toBe("Not supported on this computer");
    expect(stored.fields["choice"]?.value).toEqual({ first: 1, second: 2 });
    expect(await a.store.query("SELECT id FROM config_history WHERE kind='future_kind'")).toEqual([]);
    await a.store.query(`UPDATE computer_routes SET last_success=now(),latency_ms=12 WHERE owner_user_id=$1::uuid`, [
      a.gateway.userId,
    ]);
    expect(await a.store.query("SELECT * FROM config_items WHERE kind='computer_route'")).toEqual([]);
    expect((await a.links.snapshot()).configNotices).toEqual([]);
  }, 30_000);
});
