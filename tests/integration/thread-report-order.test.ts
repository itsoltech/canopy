import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDir } from "@canopy/testing";
import { prependThreadPage } from "@canopy/domain/history-pages";
import { DesktopHistoryCache } from "../../apps/desktop/src/history-cache.ts";
import { NetworkAccess } from "../../apps/gateway/src/network/network.ts";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { mountMobileNetwork } from "../../apps/gateway/src/network/devices.ts";
import { routedMobileClient } from "../../apps/mobile/src/api/routes.ts";
import { visibleTurns } from "../../apps/mobile/src/features/threads/thread-turns.ts";
import { coalesceDeltas } from "../../apps/web/src/lib/server/coalesce.ts";
import { buildTimeline } from "../../apps/web/src/lib/features/threads/timeline.ts";
import { nodePinnedTransport } from "./support/phone.ts";
import { eventually, SERVICE_TOKEN, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { followThread } from "./support/thread-watch.ts";

const webOrder = (state: ui.ThreadSnapshot) =>
  buildTimeline(
    state.items.flatMap((entry) =>
      entry.item
        ? [
            {
              id: entry.item.itemId,
              item: entry.item,
              turnId: entry.turnId,
              firstSeq: entry.firstSeq,
              inherited: entry.inherited,
              fromThreadId: entry.fromThreadId,
            },
          ]
        : [],
    ),
    state.turns,
    [],
    new Map(),
  ).flatMap((row) => (row.kind === "turn-start" ? [row.turn.id] : []));

describe.skipIf(!dockerAvailable)("report delivery and timeline convergence", () => {
  let gw: TestGateway;
  let network: NetworkAccess;
  let unmount: () => void;
  let phone: ReturnType<typeof routedMobileClient>;
  let deviceToken: string;
  let projectId: string;
  let workspaceId: string;
  const clients: Awaited<ReturnType<typeof followThread>>[] = [];
  const query = (sql: string, parameters: readonly string[]) => gw.core.linkedAgents.query(sql, [...parameters]);

  beforeAll(async () => {
    gw = await startTestGateway({ role: "desktop" });
    await connectPhone();
    projectId = (await gw.api.createProject({ name: "Report ordering" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo" })).workspace!.id;
  }, 60000);

  async function connectPhone() {
    network = new NetworkAccess({ store: new ComputerStore(gw.runtime, gw.userId, gw.secretsKey), host: "127.0.0.1" });
    gw.core.network = network;
    unmount = mountMobileNetwork(gw.core, network, SERVICE_TOKEN);
    await network.start();
    await network.update(create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: true }));
    const connection = gw.core.mobile.networkRoutes();
    const transport = nodePinnedTransport();

    if (!deviceToken) {
      const invitation = await gw.api.createMobilePairing({});
      deviceToken = (
        await routedMobileClient({ connection, transport }).pairing.exchangeMobilePairing({
          code: invitation.code,
          name: "Report phone",
          platform: "ios",
        })
      ).deviceToken;
    }

    phone = routedMobileClient({ connection, transport, token: deviceToken });
  }

  afterAll(async () => {
    for (const client of clients) await client.close();
    unmount?.();
    await network?.close();
    await gw?.close();
  }, 30000);

  async function watch(threadId: string, mobile = false, base?: ui.ThreadSnapshot) {
    const abort = new AbortController();

    const source = (mobile ? phone.api : gw.api).watchThread(
      {
        threadId,
        incremental: true,
        pageSize: 2,
        cursor: base?.cursor ?? "",
        fromTurnId: base?.historyBeforeTurnId ?? "",
        historyVersion: base?.historyVersion ?? "",
      },
      { signal: abort.signal },
    );

    const client = await followThread(mobile ? source : coalesceDeltas(source), abort, base);
    clients.push(client);

    return client;
  }

  async function start() {
    gw.worker.holdTurns = true;

    const parent = (
      await gw.api.createThread({
        projectId,
        workspaceId,
        provider: Provider.CODEX,
        title: "Parent",
        initialMessage: "Coordinate",
      })
    ).thread!;

    const web = await watch(parent.id);
    await web.until((state) => state.turns.some((turn) => turn.status === "running"));
    const turnId = web.state.turns[0]!.id;
    const spawnId = crypto.randomUUID();

    const spawned = await gw.worker.callTool({
      threadId: parent.id,
      turnId,
      callId: spawnId,
      tool: "spawn_thread",
      args: { title: "Child", prompt: "Work" },
    });

    expect(spawned.isError).toBe(false);
    const child = JSON.parse(spawned.resultJson) as { thread_id: string; turn_id: string };
    await eventually(async () => gw.worker.started.has(child.turn_id), Boolean);

    return { parentId: parent.id, turnId, spawnId, child, web };
  }

  test("spawn and multiple admitted steers report one child result once, including repeated sweeps", async () => {
    const pair = await start();

    for (const prompt of ["Use config first", "Confirm ADR"]) {
      expect(
        (
          await gw.worker.callTool({
            threadId: pair.parentId,
            turnId: pair.turnId,
            tool: "send_message",
            args: { thread_id: pair.child.thread_id, prompt, delivery: "steer" },
          })
        ).isError,
      ).toBe(false);
    }

    await eventually(
      () =>
        query("SELECT id FROM agent_bus_calls WHERE source_thread_id=$1::uuid AND target_turn_id=$2::uuid", [
          pair.parentId,
          pair.child.turn_id,
        ]),
      (rows) => rows.length === 3,
    );
    gw.worker.finish(pair.child.thread_id, pair.child.turn_id, "Base confirmed. Now writing config.");
    await pair.web.until((state) =>
      state.steers.some((steer) => steer.text.includes("Base confirmed") && steer.status === "delivered"),
    );
    await gw.core.sweep();
    await gw.core.sweep();

    const reports = await query(
      "SELECT id FROM turn_steers WHERE thread_id=$1::uuid AND notification_call_id IS NOT NULL",
      [pair.parentId],
    );

    expect(reports).toHaveLength(1);
    expect([...gw.worker.started.values()].filter((input) => input.text.includes("Base confirmed"))).toHaveLength(1);
    gw.worker.finish(pair.parentId, pair.turnId);
    await pair.web.close();
  }, 20000);

  test("consumed fallback disappears live and after disk resume; genuine cancellations keep their ordinal", async () => {
    const pair = await start();
    const mobile = await watch(pair.parentId, true);
    gw.worker.steerMode = "not_running";
    gw.worker.finish(pair.child.thread_id, pair.child.turn_id, "Progress report");
    await pair.web.until((state) => state.turns.some((turn) => turn.sourceKind === "report"));
    const reportId = pair.web.state.turns.find((turn) => turn.sourceKind === "report")!.id;

    const read = await gw.worker.callTool({
      threadId: pair.parentId,
      turnId: pair.turnId,
      tool: "get_thread",
      args: { thread_id: pair.child.thread_id },
    });

    expect(read.isError).toBe(false);
    await pair.web.until((state) => state.turns.some((turn) => turn.id === reportId && Boolean(turn.withdrawn)));
    await mobile.until((state) => state.turns.some((turn) => turn.id === reportId && Boolean(turn.withdrawn)));
    gw.worker.steerMode = "accept";

    // A cancelled, never-started user input has no transcript item, just like an unentered report did.
    const cancelled = (
      await gw.api.sendMessage({ threadId: pair.parentId, text: "Cancel this", clientRequestId: crypto.randomUUID() })
    ).turn!;

    await query("UPDATE turns SET status='cancelled', completed_at=now() WHERE id=$1::uuid", [cancelled.id]);
    gw.worker.holdTurns = false;
    gw.worker.finish(pair.parentId, pair.turnId);

    for (const text of ["Newer answer one", "Newer answer two"]) {
      await gw.api.sendMessage({ threadId: pair.parentId, text, clientRequestId: crypto.randomUUID() });
      await pair.web.until((state) =>
        state.items.some(
          (item) => item.item?.content.case === "agentMessage" && item.item.content.value.text === `Echo: ${text}`,
        ),
      );
    }

    // Refresh the persisted turn projection and exercise the real two-turn tail and older page.
    const tail = await watch(pair.parentId);
    const tailIds = tail.state.turns.map((turn) => turn.id);
    const checkpoint = tail.updates;
    await gw.worker.callTool({
      threadId: pair.parentId,
      turnId: pair.turnId,
      tool: "get_thread",
      args: { thread_id: pair.child.thread_id },
    });
    await eventually(
      async () => tail.updates,
      (updates) => updates > checkpoint,
    );
    expect(tail.state.turns.map((turn) => turn.id)).toEqual(tailIds);
    const pageAbort = new AbortController();

    const pages = gw.api.watchThread(
      {
        threadId: pair.parentId,
        pageSize: 2,
        beforeTurnId: tail.state.historyBeforeTurnId,
        historyVersion: tail.state.historyVersion,
      },
      { signal: pageAbort.signal },
    );

    let page: ui.ThreadSnapshot | undefined;

    for await (const update of pages) {
      if (update.change.case === "snapshot") {
        page = update.change.value;
        pageAbort.abort();
        break;
      }
    }

    const merged = prependThreadPage(tail.state, page!);
    const cache = new DesktopHistoryCache(tempDir("report-order-cache-"));
    const key = `thread_${pair.parentId}`;
    const { generation } = await cache.read(key);
    await cache.write(generation, key, toBinary(ui.ThreadSnapshotSchema, merged));

    const restored = fromBinary(
      ui.ThreadSnapshotSchema,
      (await new DesktopHistoryCache(cache.directory).read(key)).bytes!,
    );

    const resumed = await watch(pair.parentId, false, restored);
    const expected = visibleTurns(restored).map((turn) => turn.id);
    expect(expected).toContain(cancelled.id);
    expect(expected).not.toContain(reportId);
    expect(webOrder(restored)).toEqual(expected);
    expect(webOrder(resumed.state)).toEqual(expected);
    expect(resumed.state.historyBeforeTurnId).toBe(restored.historyBeforeTurnId);
    const phoneTail = await watch(pair.parentId, true, restored);
    expect(resumed.state.items).toEqual(phoneTail.state.items);
    expect(resumed.state.turns).toEqual(phoneTail.state.turns);
    await phoneTail.close();
    await resumed.close();
    await tail.close();
    await mobile.close();
    await pair.web.close();
  }, 30000);

  test("wait consumption and disk checkpoints survive a gateway restart with the same paired phone", async () => {
    const pair = await start();
    const mobile = await watch(pair.parentId, true);
    const cache = new DesktopHistoryCache(tempDir("report-restart-cache-"));
    const key = `thread_${pair.parentId}`;
    const { generation } = await cache.read(key);
    await cache.write(generation, key, toBinary(ui.ThreadSnapshotSchema, pair.web.state));
    const waitId = crypto.randomUUID();

    const waiting = gw.worker.callTool({
      threadId: pair.parentId,
      turnId: pair.turnId,
      callId: waitId,
      tool: "wait_threads",
      args: { thread_ids: [pair.child.thread_id], timeout_seconds: 10 },
    });

    await eventually(
      () => query("SELECT id FROM agent_bus_calls WHERE id=$1::uuid AND status='requested'", [waitId]),
      (rows) => rows.length === 1,
    );

    const sent = await gw.worker.callTool({
      threadId: pair.child.thread_id,
      turnId: pair.child.turn_id,
      tool: "send_message",
      args: { thread_id: pair.parentId, prompt: "Progress through wait", notify: false },
    });

    expect(sent.isError).toBe(false);
    expect(JSON.parse((await waiting).resultJson).messages).toMatchObject([{ text: "Progress through wait" }]);
    await pair.web.until((state) => state.turns.some((turn) => turn.withdrawn === "consumed"));
    await mobile.until((state) => state.turns.some((turn) => turn.withdrawn === "consumed"));
    gw.worker.finish(pair.child.thread_id, pair.child.turn_id, "Final after progress");
    await pair.web.until((state) =>
      state.steers.some((steer) => steer.status === "delivered" && steer.text.includes("Final after progress")),
    );
    gw.worker.finish(pair.parentId, pair.turnId);
    await pair.web.until((state) => state.turns.find((turn) => turn.id === pair.turnId)?.status === "completed");

    for (const client of clients) await client.close();
    unmount();
    await network.close();

    const storage = {
      pg: gw.pg,
      secretsKey: gw.secretsKey,
      workerId: gw.workerId,
      workerCredential: gw.workerCredential,
    };

    await gw.close(true);
    gw = await startTestGateway({ role: "desktop", storage });
    await connectPhone();

    const restored = fromBinary(
      ui.ThreadSnapshotSchema,
      (await new DesktopHistoryCache(cache.directory).read(key)).bytes!,
    );

    const web = await watch(pair.parentId, false, restored);
    const phoneResume = await watch(pair.parentId, true);
    await gw.core.sweep();
    expect(web.state.items).toEqual(phoneResume.state.items);
    expect(web.state.turns).toEqual(phoneResume.state.turns);
    expect(webOrder(web.state)).toEqual(visibleTurns(phoneResume.state).map((turn) => turn.id));
    expect(webOrder(web.state)).toEqual([pair.turnId]);
    expect(
      await query("SELECT id FROM turn_steers WHERE thread_id=$1::uuid AND notification_call_id IS NOT NULL", [
        pair.parentId,
      ]),
    ).toHaveLength(1);
    await web.close();
    await phoneResume.close();
  }, 30000);

  test("an idle parent receives a new report turn, and identical text from another turn is retained", async () => {
    const pair = await start();
    const mobile = await watch(pair.parentId, true);
    gw.worker.finish(pair.parentId, pair.turnId);
    await pair.web.until((state) => state.turns.find((turn) => turn.id === pair.turnId)?.status === "completed");
    gw.worker.finish(pair.child.thread_id, pair.child.turn_id, "Same final text");
    await pair.web.until((state) =>
      state.turns.some((turn) => turn.sourceKind === "report" && turn.status === "running"),
    );
    const report = pair.web.state.turns.find((turn) => turn.sourceKind === "report")!;

    const sent = await gw.worker.callTool({
      threadId: pair.parentId,
      turnId: report.id,
      tool: "send_message",
      args: { thread_id: pair.child.thread_id, prompt: "Run again" },
    });

    expect(sent.isError).toBe(false);
    const next = JSON.parse(sent.resultJson) as { turn_id: string };
    await eventually(async () => gw.worker.started.has(next.turn_id), Boolean);
    gw.worker.finish(pair.child.thread_id, next.turn_id, "Same final text");
    await pair.web.until((state) =>
      state.steers.some((steer) => steer.text.includes("Same final text") && steer.status === "delivered"),
    );
    gw.worker.finish(pair.parentId, report.id);
    await mobile.until((state) => state.turns.find((turn) => turn.id === report.id)?.status === "completed");
    await gw.core.sweep();

    const reports = await query(
      "SELECT id FROM agent_bus_calls WHERE source_thread_id=$1::uuid AND notify_status='delivered'",
      [pair.parentId],
    );

    expect(reports).toHaveLength(2);
    expect(webOrder(pair.web.state)).toEqual(visibleTurns(mobile.state).map((turn) => turn.id));
    expect(webOrder(pair.web.state)).toEqual([pair.turnId, report.id]);
    await mobile.close();
    await pair.web.close();
  }, 30000);
});
