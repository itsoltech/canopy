import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type MessageInitShape } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { qualifyId } from "@canopy/domain/computers";
import { prependThreadPage } from "@canopy/domain/history-pages";
import { applyThreadUpdate } from "@canopy/domain/thread-snapshot";
import { remoteServe, uiHandlers } from "@canopy/gateway/api";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { linkedComputers } from "./support/computers.ts";
import { eventually, startTestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("independent turn and item windows over gRPC", () => {
  let a: Awaited<ReturnType<typeof startTestGateway>>;
  let b: Awaited<ReturnType<typeof startTestGateway>>;
  let local: ReturnType<typeof linkedComputers>;
  let home: ReturnType<typeof linkedComputers>;
  let thread: string;
  let remote: string;
  let node: string;

  beforeAll(async () => {
    a = await startTestGateway({ role: "desktop" });
    b = await startTestGateway({ role: "desktop" });
    const source = new ComputerStore(b.runtime, b.userId, b.secretsKey);
    const project = (await b.api.createProject({ name: "Independent history windows" })).project!.id;

    const workspace = (
      await b.api.createWorkspace({ projectId: project, workerId: b.workerId, rootPath: "/repo/windows" })
    ).workspace!.id;

    thread = (await b.api.createThread({ projectId: project, workspaceId: workspace, provider: Provider.CODEX }))
      .thread!.id;
    await source.query(
      `INSERT INTO turns(id,thread_id,ordinal,status,trigger,author_user_id,input,first_seq,last_seq)
      SELECT md5($1 || ':' || n)::uuid,$1::uuid,n,'completed','user',$2::uuid,'{}',n*2-1,n*2
      FROM generate_series(1,80) n`,
      [thread, b.userId],
    );
    await source.query(
      `INSERT INTO thread_items(thread_id,item_id,turn_id,type,status,content,first_seq,last_seq)
      SELECT $1::uuid,'item-' || n,md5($1 || ':' || ((n+1)/2))::uuid,'agentMessage','completed',
        jsonb_build_object('itemId','item-' || n,'agentMessage',jsonb_build_object('text','Saved message')),n,n
      FROM generate_series(1,160) n`,
      [thread],
    );

    const options = (gateway: typeof a) => ({
      store: new ComputerStore(gateway.runtime, gateway.userId, gateway.secretsKey),
      core: gateway.core,
      host: "127.0.0.1",
      serve: remoteServe(uiHandlers(gateway.core)),
    });

    local = linkedComputers(options(a));
    home = linkedComputers(options(b));
    a.core.computers = local;
    b.core.computers = home;
    await local.start();
    await home.start();
    await home.pair(local.addresses[0]!, (await local.createPairing()).code);
    node = home.hello().nodeId;
    remote = qualifyId(thread, node);
    expect(
      await eventually(
        async () =>
          (
            await local.store.query<{ count: number }>(
              `SELECT count(*)::integer AS count FROM thread_range_entities
              WHERE owner_user_id=$1::uuid AND origin_node_id=$2 AND thread_id=$3::uuid AND kind IN ('turn','item')`,
              [a.userId, node, thread],
            )
          )[0]!.count,
        (count) => count === 240,
        10_000,
      ),
    ).toBe(240);
  }, 20_000);

  afterAll(async () => {
    await local?.close();
    await home?.close();
    await a?.close();
    await b?.close();
  });

  async function first(gateway: typeof a, input: MessageInitShape<typeof ui.WatchThreadRequestSchema>) {
    const abort = new AbortController();

    try {
      for await (const update of gateway.api.watchThread(input, { signal: abort.signal, timeoutMs: 5000 }))
        if (update.change.case === "snapshot") return update.change.value;
      throw new Error("Missing history window");
    } finally {
      abort.abort();
    }
  }

  test("sequence resume preserves supporting turns outside the primary turn page", async () => {
    let state = await first(b, { threadId: thread, sequence: true, pageSize: 24 });
    expect(state.items.length).toBe(128);
    expect(state.turns.length).toBe(64);
    await b.api.updateThread({ threadId: thread, title: "Window retained" });
    const abort = new AbortController();

    try {
      for await (const update of b.api.watchThread(
        { threadId: thread, sequence: true, syncCursor: state.syncCursor },
        { signal: abort.signal, timeoutMs: 5000 },
      )) {
        state = applyThreadUpdate(state, update);

        if (state.thread?.title === "Window retained") break;
      }
    } finally {
      abort.abort();
    }

    expect(state.items.length).toBe(128);
    expect(state.turns.length).toBe(64);
  });

  async function allHistory(gateway: typeof a, id: string) {
    let state = await first(gateway, { threadId: id, sequence: true, pageSize: 8 });
    expect(state.cursor.startsWith("range:")).toBe(true);
    expect(state.items.length).toBe(48);
    expect(state.historyHasMore).toBe(true);

    for (let page = 0; page < 12 && (state.historyHasMore || state.historyItemsHasMore); page++) {
      const next = await first(gateway, {
        threadId: id,
        sequence: true,
        pageSize: 8,
        beforeTurnId: state.historyBeforeTurnId,
        beforeItemId: state.historyBeforeItemId,
        historyVersion: state.historyVersion,
      });

      expect(next.historyReset).toBe(false);
      expect(next.items.length).toBeLessThanOrEqual(48);
      state = prependThreadPage(state, next);
    }

    expect(state.historyHasMore).toBe(false);
    expect(state.historyItemsHasMore).toBe(false);
    expect(state.items.length).toBe(160);
    expect(state.turns.length).toBe(80);
  }

  test("local history retains exhausted item anchors until turn paging finishes", async () => {
    await allHistory(b, thread);
  });

  test("an unreachable home retains bounded cached items and independent page boundaries", async () => {
    await home.close();
    expect(await eventually(async () => !local.reachable().includes(node), Boolean)).toBe(true);
    await allHistory(a, remote);
  });
});
