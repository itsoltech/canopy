import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { computerLink as link } from "@canopy/contracts";
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
      `INSERT INTO computer_agent_calls(owner_user_id,peer_node_id,call_id,direction,actor_id,actor_kind,target_id,target_kind,operation,hops)
      SELECT id,$3,$4::uuid,'outgoing',$4::uuid,'thread',$5::uuid,'thread','send_message',0
      FROM users WHERE id IN($1::uuid,$2::uuid)`,
      [owner, other, former, local, moved],
    );
  }, 60_000);

  afterAll(async () => {
    await runtime?.dispose();
    await pg?.stop();
  });

  test("only trusted homes can redirect; local threads and bots stay protected and another owner is isolated", async () => {
    expect(await redirects.learn("d".repeat(64), [item(moved)])).toEqual([]);
    const notices = [item(local.toUpperCase()), item(bot, "bot"), item(foreign), item(moved), item("invalid")];
    const learned = await redirects.learn(former, notices);

    expect(learned.map((value) => value.itemId)).toEqual([foreign, moved]);
    expect(redirects.home(local)).toBeUndefined();
    expect(redirects.home(bot)).toBeUndefined();
    expect(await redirects.learn(former, learned)).toEqual([]);
    expect(await redirects.learn(former, [item(moved, "thread", 999_999n)])).toEqual([]);
    expect(await redirects.learn(former, [item(moved, "thread", 1_000_001n, self)])).toEqual([]);
    expect(
      await store.query("SELECT peer_node_id FROM computer_agent_calls WHERE owner_user_id=$1::uuid", [owner]),
    ).toEqual([{ peer_node_id: home }]);
    expect(
      await store.query("SELECT peer_node_id FROM computer_agent_calls WHERE owner_user_id=$1::uuid", [other]),
    ).toEqual([{ peer_node_id: former }]);
    const foreignRedirects = new Redirects(new ComputerStore(runtime, other, Buffer.alloc(32, 1)), () => self);
    await foreignRedirects.load();

    expect(foreignRedirects.size).toBe(0);
  });

  test("UUID case preserves single-notice deduplication and routing after reload", async () => {
    const upper = crypto.randomUUID().toUpperCase();
    const notice = item(upper);
    expect(await redirects.record(notice)).toBe(true);
    expect(redirects.home(upper)?.item_id).toBe(upper.toLowerCase());
    expect(redirects.item(upper)?.itemId).toBe(upper.toLowerCase());
    expect(await redirects.record(notice)).toBe(false);
    expect(await redirects.learn(former, [item(upper.toLowerCase())])).toEqual([]);
    await redirects.load();

    expect(redirects.home(upper)?.home_node_id).toBe(home);
    expect(await redirects.record(notice)).toBe(false);
  });

  test("ordered notices for one object keep the newest home across a restart", async () => {
    const next = "e".repeat(64);
    const notices = [item(moved, "thread", 1_000_002n, next), item(moved, "thread", 1_000_001n, home)];
    expect((await redirects.learn(former, notices)).map((value) => value.homeNodeId)).toEqual([next]);
    await runtime.dispose();
    runtime = ManagedRuntime.make(gatewayServices(Buffer.alloc(32, 1)).pipe(Layer.provideMerge(pg.layer)));
    redirects = new Redirects(new ComputerStore(runtime, owner, Buffer.alloc(32, 1)), () => self);
    await redirects.load();

    expect(redirects.home(moved)?.home_node_id).toBe(next);
    expect(await redirects.learn(former, notices)).toEqual([]);
    expect(redirects.list().map((value) => value.itemId)).toContain(moved);
    const tied = [item(moved, "thread", 1_000_002n, home), item(moved, "thread", 1_000_002n, next)];
    expect((await redirects.learn(former, tied)).map((value) => value.homeNodeId)).toEqual([home, next]);
    expect(redirects.home(moved)?.home_node_id).toBe(next);
  });
});
