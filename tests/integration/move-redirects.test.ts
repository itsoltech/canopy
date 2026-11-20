import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { computerLink as link, ui } from "@canopy/contracts";
import { qualifyId } from "@canopy/domain/computers";
import { dockerAvailable, startPostgres, type TestPostgres } from "@canopy/db/testing";
import { Layer, ManagedRuntime } from "effect";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { Redirects } from "../../apps/gateway/src/computers/redirects.ts";
import type { CoreRuntime } from "../../apps/gateway/src/core/core.ts";
import { gatewayServices } from "../../apps/gateway/src/runtime.ts";

describe.skipIf(!dockerAvailable)("durable move redirects", () => {
  let pg: TestPostgres;
  let runtime: CoreRuntime;
  let store: ComputerStore;
  let redirects: Redirects;
  const owner = Bun.randomUUIDv7();
  const other = Bun.randomUUIDv7();
  const self = "a".repeat(64);
  const home = "b".repeat(64);
  const former = "c".repeat(64);
  const local = Bun.randomUUIDv7();
  const foreign = Bun.randomUUIDv7();
  const bot = Bun.randomUUIDv7();
  const moved = Bun.randomUUIDv7();

  const item = (itemId: string, kind = "thread", movedAtMs = 1_000_000n, homeNodeId = home) =>
    create(link.MovedItemSchema, { itemId, kind, movedAtMs, homeNodeId, fromNodeId: former, homeName: "Synthetic" });

  beforeAll(async () => {
    pg = await startPostgres({ migrated: true });
    runtime = ManagedRuntime.make(gatewayServices(Buffer.alloc(32, 1)).pipe(Layer.provideMerge(pg.layer)));
    store = new ComputerStore(runtime, owner, Buffer.alloc(32, 1));
    redirects = new Redirects(store, () => self);
    await store.query(
      "INSERT INTO users(id,email,display_name,role) VALUES($1::uuid,'redirect-owner@example.test','Owner','user'),($2::uuid,'redirect-other@example.test','Other','user')",
      [owner, other],
    );
    await store.query(
      "INSERT INTO projects(id,owner_user_id,name,slug) VALUES($1::uuid,$1::uuid,'Owner','owner'),($2::uuid,$2::uuid,'Other','other')",
      [owner, other],
    );
    await store.query(
      `INSERT INTO threads(id,root_thread_id,project_id,owner_user_id,kind,runtime,provider,status)
      VALUES($1::uuid,$1::uuid,$2::uuid,$2::uuid,'main','gateway','anthropic','idle'),
      ($3::uuid,$3::uuid,$4::uuid,$4::uuid,'main','gateway','anthropic','idle')`,
      [local, owner, foreign, other],
    );
    await store.query(
      "INSERT INTO bots(id,owner_user_id,client_request_id,configuration,provider,provider_instance) VALUES($1::uuid,$2::uuid,'local','{}','codex','native')",
      [bot, owner],
    );
    await store.query(
      `INSERT INTO computer_agent_calls(owner_user_id,peer_node_id,call_id,direction,actor_id,actor_kind,target_id,target_kind,operation,hops,result)
      SELECT id,$3,$4::uuid,'outgoing',$4::uuid,'thread',$5::uuid,'thread','send',0,'{}'::jsonb
      FROM users WHERE id IN($1::uuid,$2::uuid)`,
      [owner, other, former, local, moved],
    );
  }, 60_000);

  afterAll(async () => {
    await runtime?.dispose();
    await pg?.stop();
  });

  test("a former home confirms only its typed references and the receiving owner's calls", async () => {
    expect(await redirects.learn(home, [item(moved)])).toEqual([]);
    const learned = await redirects.learn(former, [item(local), item(bot, "bot"), item(foreign), item(moved)]);
    expect(learned.map((i) => i.itemId)).toEqual([local, bot, foreign, moved]);
    expect(redirects.map("thread", local)).toBe(local);
    expect(redirects.map("bot", bot)).toBe(bot);
    expect(redirects.map("thread", qualifyId(local, former))).toBe(qualifyId(local, home));
    expect(redirects.map("thread", qualifyId(bot, former))).toBe(qualifyId(bot, former));
    expect(await redirects.learn(former, learned)).toEqual([]);
    expect(await redirects.learn(former, [item(moved, "thread", 1_000_001n, self)])).toEqual([]);
    expect(
      await store.query("SELECT peer_node_id,detached FROM computer_agent_calls WHERE owner_user_id=$1::uuid", [owner]),
    ).toEqual([{ peer_node_id: home, detached: true }]);
    expect(
      await store.query("SELECT peer_node_id FROM computer_agent_calls WHERE owner_user_id=$1::uuid", [other]),
    ).toEqual([{ peer_node_id: former }]);
    const foreignRedirects = new Redirects(new ComputerStore(runtime, other, Buffer.alloc(32, 1)), () => self);
    await foreignRedirects.load();
    expect(foreignRedirects.size).toBe(0);
  });

  test("thread and bot links survive reload without changing a worker, secret request or operation ID", async () => {
    const upper = crypto.randomUUID().toUpperCase();
    const next = "e".repeat(64);
    await redirects.learn(former, [item(upper), item(upper, "bot", 1_000_000n, next)]);
    await redirects.load();
    const before = qualifyId(upper, former);
    const send = create(ui.SendMessageRequestSchema, { threadId: before, clientRequestId: before });
    expect(redirects.rewrite(ui.SendMessageRequestSchema, send)).toBe(true);
    expect(send.threadId).toBe(qualifyId(upper.toLowerCase(), home));
    expect(send.clientRequestId).toBe(before);
    expect(redirects.map("bot", before)).toBe(qualifyId(upper.toLowerCase(), next));
    const turn = crypto.randomUUID();

    const watch = create(ui.WatchThreadRequestSchema, {
      threadId: before,
      beforeTurnId: qualifyId(turn, former),
      syncCursor: { threadId: before, epoch: "old" },
    });

    expect(redirects.rewrite(ui.WatchThreadRequestSchema, watch)).toBe(true);
    expect(watch.beforeTurnId).toBe(qualifyId(turn, home));
    expect(watch.syncCursor).toBeUndefined();
    const visual = create(ui.GetVisualRequestSchema, { threadId: before, visualId: qualifyId(turn, next) });
    redirects.rewrite(ui.GetVisualRequestSchema, visual);
    expect(visual.visualId).toBe(qualifyId(turn, next));
    const secret = create(ui.RevokeThreadSecretRequestSchema, { requestId: before });
    expect(redirects.rewrite(ui.RevokeThreadSecretRequestSchema, secret)).toBe(false);
    const models = create(ui.ListModelsRequestSchema, { workerId: before });
    expect(redirects.rewrite(ui.ListModelsRequestSchema, models)).toBe(false);
    expect(redirects.map("thread", qualifyId(upper, next))).toBe(qualifyId(upper, next));
    expect(redirects.list()).toEqual([]);
  });

  test("successive departures require each former home and retain the original link", async () => {
    const next = "e".repeat(64);

    const second = create(link.MovedItemSchema, {
      ...item(moved, "thread", 1_000_002n, next),
      fromNodeId: home,
    });

    expect(await redirects.learn(former, [second])).toEqual([]);
    expect(await redirects.learn(home, [second])).toHaveLength(1);
    await redirects.load();
    expect(redirects.map("thread", qualifyId(moved, former))).toBe(qualifyId(moved, next));
    expect(redirects.map("thread", qualifyId(moved, home))).toBe(qualifyId(moved, next));
    expect(await redirects.learn(former, [item(moved, "thread", 999_999n)])).toEqual([]);
  });
});
