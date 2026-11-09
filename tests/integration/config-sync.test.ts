import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { computerLink as link, ui } from "@canopy/contracts";
import { CONFIG_SYNC, REMOTE_THREADS } from "@canopy/domain/computers";
import { dockerAvailable } from "@canopy/db/testing";
import { Code, ConnectError } from "@connectrpc/connect";
import { configAllowed } from "../../apps/gateway/src/computers/runtime-config.ts";
import { linkedMessage } from "../../apps/gateway/src/computers/remote.ts";
import { configComputer, pairConfig, type ConfigComputer } from "./support/config-sync.ts";
import { eventually } from "./support/gateway.ts";

const wait = async (predicate: () => Promise<boolean> | boolean) =>
  expect(await eventually(async () => predicate(), Boolean, 20_000)).toBe(true);

const synced = (...pairs: [ConfigComputer, ConfigComputer][]) =>
  wait(() => pairs.every(([a, b]) => configAllowed(a.links, b.node) && configAllowed(b.links, a.node)));

const count = async (computer: ConfigComputer, table: string) =>
  (
    await computer.store.query<{ n: number }>(
      `SELECT count(*)::integer AS n FROM ${table} WHERE owner_user_id=$1::uuid`,
      [computer.gateway.userId],
    )
  )[0]!.n;

/** Equal values can still be different concurrent versions; the next edit waits for the choice itself. */
const settledTimezone = (...computers: ConfigComputer[]) =>
  wait(async () => {
    const versions = await Promise.all(
      computers.map((computer) =>
        computer.store.query<{ hlc: string }>(
          "SELECT fields->'timezone'->>'hlc' AS hlc FROM config_items WHERE kind='settings' AND global_id='account'",
        ),
      ),
    );

    return new Set(versions.map((rows) => rows[0]?.hlc)).size === 1;
  });

describe.skipIf(!dockerAvailable)("account configuration across three independently stored gateways", () => {
  let a: ConfigComputer;
  let b: ConfigComputer;
  let c: ConfigComputer;

  beforeAll(async () => {
    a = await configComputer("Laptop A");
    b = await configComputer("Laptop B");
    c = await configComputer("Laptop C");
    await pairConfig(a, b);
    await pairConfig(b, c);
    await synced([a, b], [b, c]);
  }, 90_000);
  afterAll(async () => {
    await Promise.allSettled([a?.close(), b?.close(), c?.close()]);
  }, 30_000);

  test("live settings converge over A–B–C and layout, workspace and gateway settings stay local", async () => {
    await a.update({
      timezone: "Europe/Warsaw",
      appearance: { accent: ui.AccentTheme.OCEAN, sidebarWidth: 312, sidebarCollapsed: true },
      general: { confirmDelete: false },
      composer: { runningDelivery: ui.MessageDelivery.QUEUE },
      cliUpdates: { intervalMinutes: 60 },
    });
    await wait(
      async () =>
        (await c.settings()).timezone === "Europe/Warsaw" && (await b.settings()).general?.confirmDelete === false,
    );
    expect((await c.settings()).appearance).toMatchObject({
      accent: ui.AccentTheme.OCEAN,
      sidebarWidth: 0,
      sidebarCollapsed: false,
    });
    expect((await c.settings()).composer?.runningDelivery).toBe(ui.MessageDelivery.QUEUE);
    expect((await c.settings()).cliUpdates?.intervalMinutes).toBe(60);
    await wait(async () => (await a.links.snapshot()).configGroup.length === 3);

    const records = await a.store.query<{ fields: object }>(
      "SELECT fields FROM config_items WHERE owner_user_id=$1::uuid AND kind='settings'",
      [a.gateway.userId],
    );

    expect(JSON.stringify(records)).not.toContain("sidebarWidth");
    expect(JSON.stringify(records)).not.toContain("workspaceId");
    expect(a.links.hello().capabilities).toContain(CONFIG_SYNC);
    expect(a.links.hello().capabilities).not.toContain("shared_config");
  }, 30_000);

  test("different fields merge, conflicting values wait for a choice and Restore propagates", async () => {
    await a.sharing(b.node, false);
    await wait(() => !configAllowed(b.links, a.node));
    await a.update({
      timezone: "America/New_York",
      textGeneration: { threadTitleInstructions: "Keep titles concise" },
    });
    await b.update({ timezone: "Asia/Tokyo", general: { confirmUnpin: true } });
    await a.sharing(b.node, true);
    await synced([a, b]);
    await wait(
      async () =>
        (await a.links.snapshot()).configNotices.some((n) => n.field === "timezone" && n.reason === "choice") &&
        (await c.settings()).textGeneration?.threadTitleInstructions === "Keep titles concise" &&
        (await a.settings()).general?.confirmUnpin === true,
    );
    const notices = (await a.links.snapshot()).configNotices.filter((n) => n.field === "timezone");
    expect(notices.length).toBeGreaterThan(0);
    const notice = notices[0]!;
    const restore = JSON.parse(notice.value);
    const otherNotice = (await b.links.snapshot()).configNotices.find((n) => n.field === "timezone");
    expect(otherNotice).toBeDefined();
    await b.gateway.api.manageConfigNotice({ id: otherNotice!.id, action: "dismiss" });
    await wait(async () => (await c.settings()).timezone === restore);
    await wait(async () => !(await a.links.snapshot()).configNotices.some((n) => n.id === notice.id));
    await settledTimezone(a, b, c);
    expect((await a.links.snapshot()).configNotices.some((n) => n.id === notice.id)).toBe(false);
    const history = await count(a, "config_history");
    await a.restart();
    await synced([a, b]);
    expect((await a.settings()).timezone).toBe(restore);
    expect(await count(a, "config_history")).toBe(history);
  }, 40_000);

  test("off links reject before any response, close active streams and retain data on both sides", async () => {
    const abort = new AbortController();

    const stream = a.links.remote(
      b.node,
      link.ConfigSyncService.method.watchConfig,
      create(link.ConfigCursorSchema),
      abort.signal,
    );

    expect((await stream.next()).done).toBe(false);
    const beforeA = (await a.settings()).timezone;
    const beforeB = (await b.settings()).timezone;
    await a.sharing(b.node, false);
    await wait(() => !configAllowed(b.links, a.node));

    // Drain frames queued before the consent change; the stream must then finish.
    const closed = await eventually(
      async () => stream.next().catch(() => ({ done: true })),
      (r) => !!r.done,
      5000,
    );

    expect(closed.done).toBe(true);
    abort.abort();
    expect((await a.settings()).timezone).toBe(beforeA);
    expect((await b.settings()).timezone).toBe(beforeB);
    let sent = 0;
    let refused: ConnectError | undefined;

    try {
      for await (const _message of a.links.remote(
        b.node,
        link.ConfigSyncService.method.watchConfig,
        create(link.ConfigCursorSchema),
        AbortSignal.timeout(5000),
      ))
        sent++;
    } catch (error) {
      if (error instanceof ConnectError) refused = error;
      else throw error;
    }

    expect(sent).toBe(0);
    expect(refused?.code).toBe(Code.FailedPrecondition);
    await a.update({ timezone: "Pacific/Auckland" });
    await c.update({ timezone: "Europe/London" });
    await wait(async () => (await b.settings()).timezone === "Europe/London");
    expect((await a.settings()).timezone).toBe("Pacific/Auckland");
    expect((await a.links.snapshot()).configGroup.length).toBe(1);
    await wait(async () => (await c.links.snapshot()).configGroup.length === 2);
  }, 30_000);

  test("a refusal persists after restarts and reconnect; only its author can resume sharing", async () => {
    await a.restart();
    await b.restart();
    await wait(() => a.links.reachable().includes(b.node));
    expect(configAllowed(a.links, b.node)).toBe(false);
    await b.sharing(a.node, true);
    expect((await b.store.peer(a.node))?.peer_share_config).toBe(false);
    expect(configAllowed(b.links, a.node)).toBe(false);
    await a.update({ timezone: "America/Chicago" });
    await c.update({ timezone: "Europe/Paris" });
    await wait(async () => (await b.settings()).timezone === "Europe/Paris");
    expect((await a.settings()).timezone).toBe("America/Chicago");
    await a.sharing(b.node, true);
    await synced([a, b], [b, c]);
    await wait(async () =>
      (await a.links.snapshot()).configNotices.some((n) => n.field === "timezone" && n.reason === "choice"),
    );

    const choice = (await a.links.snapshot()).configNotices.find(
      (n) => n.field === "timezone" && n.reason === "choice",
    )!;

    await a.gateway.api.manageConfigNotice({ id: choice.id, action: "restore" });
    await wait(async () => (await a.settings()).timezone === (await c.settings()).timezone);
    await settledTimezone(a, b, c);
    await wait(async () => (await a.links.snapshot()).configGroup.length === 3);

    for (const computer of [a, b, c]) {
      expect(
        (
          await computer.store.query(
            "SELECT global_id FROM config_items WHERE owner_user_id=$1::uuid AND kind='settings'",
            [computer.gateway.userId],
          )
        ).length,
      ).toBe(1);
    }
  }, 40_000);

  test("valid cursors resume; missing, stale and future cursors resend; checkpoints survive restarts", async () => {
    const cursor = (
      await a.store.query<{ cursor: string }>(
        "SELECT cursor FROM config_peer_cursors WHERE owner_user_id=$1::uuid AND node_id=$2",
        [a.gateway.userId, b.node],
      )
    )[0]!.cursor;

    expect(cursor).toMatch(/^[a-f0-9-]{36}:\d+$/);

    for (const value of ["", "00000000-0000-0000-0000-000000000000:1", `${cursor.split(":")[0]}:999999999999`]) {
      const controller = new AbortController();

      const stream = a.links.remote(
        b.node,
        link.ConfigSyncService.method.watchConfig,
        create(link.ConfigCursorSchema, { cursor: value }),
        controller.signal,
      );

      await stream.next();
      const message = (await stream.next()).value;
      expect(message).toBeDefined();
      const batch = linkedMessage(link.ConfigUpdateSchema, message!);
      expect(batch?.reset).toBe(true);
      expect(batch?.items.some((i) => i.kind === "settings")).toBe(true);
      controller.abort();
      await stream.return(undefined);
    }

    await a.restart();

    const resumed = (
      await a.store.query<{ cursor: string }>(
        "SELECT cursor FROM config_peer_cursors WHERE owner_user_id=$1::uuid AND node_id=$2",
        [a.gateway.userId, b.node],
      )
    )[0]!.cursor;

    expect(resumed.split(":")[0]).toBe(cursor.split(":")[0]);
    // Reconnection can already have committed a newer batch; it must never forget the durable checkpoint.
    expect(BigInt(resumed.split(":")[1]!)).toBeGreaterThanOrEqual(BigInt(cursor.split(":")[1]!));
    await synced([a, b]);
    await b.update({ timezone: "Europe/Berlin" });
    await wait(async () => (await a.settings()).timezone === "Europe/Berlin");
  }, 30_000);

  test("an alternate consenting path keeps one group even when its direct link is off", async () => {
    await pairConfig(a, c);
    await synced([a, c]);
    await a.sharing(b.node, false);
    await a.update({ timezone: "Europe/Rome" });
    await wait(async () => (await b.settings()).timezone === "Europe/Rome");
    expect((await a.links.snapshot()).configGroup.length).toBe(3);
    await a.sharing(b.node, true);
    await synced([a, b]);
  }, 30_000);
});

describe.skipIf(!dockerAvailable)("configuration boundaries", () => {
  test("pairing can start with sharing off; an older peer never receives configuration", async () => {
    const a = await configComputer("Private computer");
    const b = await configComputer("Work computer");
    const old = await configComputer("Older computer", ["presence", "unlink", REMOTE_THREADS]);

    try {
      await pairConfig(a, b, false, true);
      await pairConfig(a, old);
      await wait(() => a.links.reachable().includes(b.node) && a.links.reachable().includes(old.node));
      await a.update({ timezone: "Asia/Tokyo" });
      expect(configAllowed(b.links, a.node)).toBe(false);
      expect((await b.settings()).timezone).not.toBe("Asia/Tokyo");
      expect((await old.settings()).timezone).not.toBe("Asia/Tokyo");
      // Both sides name the computer without the capability: the partner on A, this computer on the older one.
      const onA = (await a.links.snapshot()).peers.find((p) => p.nodeId === old.node)!;
      expect(onA).toMatchObject({ configSyncStatus: "needs_update", configUpdateNodeId: old.node });
      expect(onA.appVersion).not.toBe("");
      const onOld = (await old.links.snapshot()).peers.find((p) => p.nodeId === a.node)!;
      expect(onOld).toMatchObject({ configSyncStatus: "needs_update", configUpdateNodeId: old.node });
      expect((await a.links.snapshot()).peers.find((p) => p.nodeId === b.node)?.configUpdateNodeId).toBe("");
      expect(await count(old, "config_peer_cursors")).toBe(0);
      const owner = crypto.randomUUID();
      await a.store.query("INSERT INTO users(id,email,display_name,role) VALUES($1::uuid,$2,'Other owner','user')", [
        owner,
        `${owner}@example.test`,
      ]);
      await a.store.query(
        "INSERT INTO config_items(owner_user_id,kind,global_id,fields,revision) VALUES($1::uuid,'private_kind','hidden','{}',1)",
        [owner],
      );
      await a.sharing(b.node, true);
      await synced([a, b]);
      await wait(async () => (await b.settings()).timezone === "Asia/Tokyo");
      expect((await b.store.query("SELECT * FROM config_items WHERE global_id='hidden'")).length).toBe(0);
      const noticeId = crypto.randomUUID();
      await a.store.query(
        `INSERT INTO config_history(id,owner_user_id,kind,global_id,field,value,hlc,node_id,notice_node_id)
        VALUES($1::uuid,$2::uuid,'settings','account','timezone','"Asia/Tokyo"',$3,$4,$4)`,
        [noticeId, owner, `${Date.now()}.0.${a.node}`, a.node],
      );
      await expect(a.gateway.api.manageConfigNotice({ id: noticeId, action: "restore" })).rejects.toBeDefined();
      await expect(a.gateway.api.manageConfigNotice({ id: noticeId, action: "dismiss" })).rejects.toBeDefined();
      expect((await a.links.snapshot()).configNotices.some((n) => n.id === noticeId)).toBe(false);
      expect(
        (await a.store.query<{ state: string }>("SELECT state FROM config_history WHERE id=$1::uuid", [noticeId]))[0]
          ?.state,
      ).toBe("open");
    } finally {
      await Promise.allSettled([a.close(), b.close(), old.close()]);
    }
  }, 90_000);
});
