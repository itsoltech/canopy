import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { dockerAvailable } from "@canopy/db/testing";
import { ui } from "@canopy/contracts";
import { create } from "@bufbuild/protobuf";
import { nodeRef } from "@canopy/domain/computers";
import { configAllowed } from "../../apps/gateway/src/computers/runtime-config.ts";
import { nextClock } from "../../apps/gateway/src/config-sync/clock.ts";
import { configLock, emptyRecord, saveRecord, type ConfigRow } from "../../apps/gateway/src/config-sync/persistence.ts";
import { configComputer, pairConfig, type ConfigComputer } from "./support/config-sync.ts";
import { eventually } from "./support/gateway.ts";

const wait = async (predicate: () => Promise<boolean> | boolean) =>
  expect(await eventually(async () => predicate(), Boolean, 20_000)).toBe(true);

async function record(computer: ConfigComputer, kind: string, id = "account") {
  return (
    await computer.store.query<ConfigRow>(
      "SELECT * FROM config_items WHERE owner_user_id=$1::uuid AND kind=$2 AND global_id=$3",
      [computer.gateway.userId, kind, id],
    )
  )[0];
}

/** Emulate a newer gateway publishing records with fields this binary cannot yet materialize. */
async function publish(computer: ConfigComputer, rows: ConfigRow[]) {
  await computer.gateway.runtime.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const clock = yield* configLock(sql, computer.gateway.userId);
          let hlc = clock.hlc;

          for (const row of rows) {
            hlc = nextClock(hlc, computer.node);
            yield* saveRecord(sql, computer.gateway.userId, row, hlc);
          }
        }),
      ),
    ),
  );
}

describe.skipIf(!dockerAvailable)("configuration replay and version skew over linked gateways", () => {
  let a: ConfigComputer;
  let b: ConfigComputer;
  let c: ConfigComputer;

  beforeAll(async () => {
    a = await configComputer("Newer computer");
    b = await configComputer("Middle computer");
    c = await configComputer("Third computer");
    await pairConfig(a, b);
    await pairConfig(b, c);
    await wait(() => configAllowed(a.links, b.node) && configAllowed(b.links, c.node));
    await wait(async () => (await a.links.snapshot()).configGroup.length === 3);
  }, 90_000);
  afterAll(async () => {
    await a?.close();
    await b?.close();
    await c?.close();
  });

  test("a failed batch commits neither settings nor cursor; a gateway restart replays it once", async () => {
    const before = (await b.settings()).timezone;

    const cursor = (
      await b.store.query<{ cursor: string }>(
        "SELECT cursor FROM config_peer_cursors WHERE owner_user_id=$1::uuid AND node_id=$2",
        [b.gateway.userId, a.node],
      )
    )[0]!.cursor;

    await b.store.query(`CREATE FUNCTION config_test_fault() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.kind='future_kind' THEN RAISE EXCEPTION 'interrupted batch'; END IF; RETURN NEW; END $$`);
    await b.store.query(
      "CREATE TRIGGER config_test_fault BEFORE INSERT OR UPDATE ON config_items FOR EACH ROW EXECUTE FUNCTION config_test_fault()",
    );
    const settings = (await record(a, "settings"))!;
    const hlc = nextClock(settings.fields["timezone"]!.hlc, a.node);
    settings.fields["timezone"] = { value: "Europe/Zurich", hlc, prev: settings.fields["timezone"]!.hlc };
    const future = emptyRecord("future_kind", "future-record");
    future.identity = "future-identity";
    future.fields["futureChoice"] = { value: { list: ["kept"] }, hlc, prev: "", edited: true, seen: [] };
    future.schema_version = 2;
    await publish(a, [settings, future]);
    // The trigger has actually interrupted receipt, rather than an idle connection hiding a partial write.
    await wait(
      async () => (await b.links.snapshot()).peers.find((p) => p.nodeId === a.node)?.configSyncStatus === "syncing",
    );
    expect((await b.settings()).timezone).toBe(before);
    await b.restart();
    expect((await b.settings()).timezone).toBe(before);
    expect(
      (
        await b.store.query<{ cursor: string }>(
          "SELECT cursor FROM config_peer_cursors WHERE owner_user_id=$1::uuid AND node_id=$2",
          [b.gateway.userId, a.node],
        )
      )[0]!.cursor,
    ).toBe(cursor);
    await b.store.query("DROP TRIGGER config_test_fault ON config_items");
    await b.store.query("DROP FUNCTION config_test_fault()");
    await wait(async () => (await c.settings()).timezone === "Europe/Zurich");
    await wait(async () => !!(await record(c, "future_kind", "future-record")));
    expect((await record(c, "future_kind", "future-record"))?.fields).toEqual(future.fields);
    expect((await record(c, "future_kind", "future-record"))?.identity).toBe("future-identity");
    expect((await record(c, "future_kind", "future-record"))?.unsupported).toBe("Not supported on this computer");
    expect(await b.store.query("SELECT * FROM config_items WHERE kind='future_kind'")).toHaveLength(1);
  }, 40_000);

  test("future fields and unsupported values survive receipt, local writes and re-publication", async () => {
    const row = (await record(a, "settings"))!;
    const hlc = nextClock(row.fields["appearance.accent"]!.hlc, a.node);
    row.fields["appearance.accent"] = { value: "ACCENT_THEME_FUTURE", hlc, prev: row.fields["appearance.accent"]!.hlc };
    row.fields["future.choice"] = { value: ["kept"], hlc, prev: "" };
    await publish(a, [row]);
    await wait(async () => (await record(c, "settings"))?.fields["appearance.accent"]?.value === "ACCENT_THEME_FUTURE");
    expect((await c.settings()).appearance?.accent).not.toBe("ACCENT_THEME_FUTURE");
    expect((await record(c, "settings"))?.unsupported).toBe("Not supported on this computer");
    await b.update({ general: { confirmUnpin: true } });
    await wait(async () => (await record(c, "settings"))?.fields["general.confirmUnpin"]?.value === true);
    expect((await record(c, "settings"))?.fields["future.choice"]?.value).toEqual(["kept"]);
    await a.update({ appearance: { accent: ui.AccentTheme.OCEAN } });
    await wait(async () => (await c.settings()).appearance?.accent === ui.AccentTheme.OCEAN);
    expect((await record(c, "settings"))?.fields["future.choice"]?.value).toEqual(["kept"]);
  }, 30_000);

  test("global pins round-trip and inherited CLI changes reach the receiving computer's worker", async () => {
    const threadId = crypto.randomUUID();
    await a.update({ sidebar: { pinnedThreadIds: [threadId] }, cliUpdates: { intervalMinutes: 60 } });
    await wait(
      async () => (await c.settings()).sidebar?.pinnedThreadIds.includes(`${threadId}~${nodeRef(a.node)}`) === true,
    );
    await wait(() => c.gateway.worker.configs.at(-1)?.cliUpdateCheckMinutes === 60);
    expect((await record(c, "settings"))?.fields["sidebar.pinnedThreadIds"]?.value).toEqual([`${threadId}@${a.node}`]);
    const sidebar = create(ui.SidebarSettingsSchema, (await c.settings()).sidebar);
    sidebar.workingSection = true;
    await c.update({ sidebar, general: { confirmUnpin: true } });
    await wait(async () => (await a.settings()).general?.confirmUnpin === true);
    expect((await a.settings()).sidebar?.workingSection).toBe(false);
    expect((await c.settings()).sidebar?.workingSection).toBe(true);
    expect((await a.settings()).sidebar?.pinnedThreadIds).toEqual([threadId]);
  }, 30_000);

  test("a shared default timezone clears an older local choice and survives restart", async () => {
    expect((await c.settings()).timezone).toBe("Europe/Zurich");
    const row = (await record(a, "settings"))!;
    const previous = row.fields["timezone"]!;
    row.fields["timezone"] = { value: "", hlc: nextClock(previous.hlc, a.node), prev: previous.hlc };
    await publish(a, [row]);
    await wait(async () => (await b.settings()).timezone === "" && (await c.settings()).timezone === "");
    await c.restart();
    expect((await c.settings()).timezone).toBe("");
  }, 30_000);

  test("tombstones discard payloads, prevent stale resurrection and preserve deletion history", async () => {
    const row = emptyRecord("future_kind", "removed-record");
    const hlc = nextClock("", a.node, Date.now() + 720_000);
    row.fields["name"] = { value: "Before deletion", hlc, prev: "" };
    await publish(a, [row]);
    await wait(async () => !!(await record(c, "future_kind", row.global_id)));
    const deleted = structuredClone(row);
    deleted.deleted = { value: true, hlc: nextClock(hlc, a.node), prev: "" };
    deleted.fields = {};
    await publish(a, [deleted]);
    await wait(async () => (await record(c, "future_kind", row.global_id))?.deleted.value === true);
    expect((await record(c, "future_kind", row.global_id))?.fields).toEqual({});
    await publish(a, [row]);
    await a.store.query("DELETE FROM config_peer_cursors WHERE owner_user_id=$1::uuid", [a.gateway.userId]);
    await a.restart();
    await wait(async () => (await record(a, "future_kind", row.global_id))?.deleted.value === true);
    expect((await record(c, "future_kind", row.global_id))?.fields).toEqual({});
    expect(
      await c.store.query("SELECT * FROM config_history WHERE global_id=$1 AND field='name'", [row.global_id]),
    ).toHaveLength(1);
    row.fields["name"] = { value: "Changed after deletion", hlc: nextClock(deleted.deleted.hlc, a.node), prev: hlc };
    row.deleted = deleted.deleted;
    await publish(a, [row]);
    await wait(
      async () => (await record(c, "future_kind", row.global_id))?.fields["name"]?.value === "Changed after deletion",
    );
    expect((await c.links.snapshot()).configNotices.some((n) => n.reason === "resurrected")).toBe(true);
    expect((await c.links.snapshot()).peers.find((p) => p.nodeId === b.node)?.configClockAheadMinutes).toBeGreaterThan(
      5,
    );
  }, 30_000);

  test("deleted account settings reset shared preferences, stay deleted after restart and Restore propagates", async () => {
    await c.update({ timezone: "Europe/Warsaw", appearance: { accent: ui.AccentTheme.OCEAN, sidebarWidth: 301 } });
    const row = (await record(c, "settings"))!;

    const clock = (
      await c.store.query<{ hlc: string }>("SELECT hlc FROM config_clock WHERE owner_user_id=$1::uuid", [
        c.gateway.userId,
      ])
    )[0]!.hlc;

    row.fields = {};
    row.deleted = { value: true, hlc: nextClock(clock, c.node), prev: row.deleted.hlc };
    await publish(a, [row]);
    await wait(async () => (await record(c, "settings"))?.deleted.value === true);
    expect((await c.settings()).timezone).toBe("");
    expect((await c.settings()).appearance?.sidebarWidth).toBe(301);
    expect((await c.settings()).sidebar?.pinnedThreadIds).toEqual([]);
    await c.restart();
    expect((await record(c, "settings"))?.fields).toEqual({});

    const notice = (await c.links.snapshot()).configNotices.find(
      (n) => n.field === "timezone" && n.reason === "deleted",
    );

    expect(notice).toBeDefined();
    await c.gateway.api.manageConfigNotice({ id: notice!.id, action: "restore" });
    await wait(async () => (await b.settings()).timezone === JSON.parse(notice!.value));
    expect((await c.settings()).appearance?.sidebarWidth).toBe(301);
  }, 30_000);
});
