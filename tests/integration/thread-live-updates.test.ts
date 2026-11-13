import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { ItemDeltaField, ItemStatus, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { applyThreadUpdate } from "@canopy/domain/thread-snapshot";
import { validateThreadBatch } from "@canopy/domain/thread-sync";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { NetworkAccess } from "../../apps/gateway/src/network/network.ts";
import { mountMobileNetwork } from "../../apps/gateway/src/network/devices.ts";
import { routedMobileClient } from "../../apps/mobile/src/api/routes.ts";
import { nodePinnedTransport } from "./support/phone.ts";
import { eventually, SERVICE_TOKEN, startTestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("large live client thread updates", () => {
  let gateway: Awaited<ReturnType<typeof startTestGateway>>;
  let store: ComputerStore;
  let network: NetworkAccess;
  let unmount: () => void;
  let phone: ReturnType<typeof routedMobileClient>;
  let thread: string;
  let turn: string;
  beforeAll(async () => {
    gateway = await startTestGateway({ watchProbeMs: 100 });
    store = new ComputerStore(gateway.runtime, gateway.userId, gateway.secretsKey);
    gateway.worker.holdTurns = true;
    const project = (await gateway.api.createProject({ name: "Large live updates" })).project!.id;

    const workspace = (
      await gateway.api.createWorkspace({
        projectId: project,
        workerId: gateway.workerId,
        rootPath: "/repo/live-updates",
      })
    ).workspace!.id;

    thread = (
      await gateway.api.createThread({
        projectId: project,
        workspaceId: workspace,
        provider: Provider.CODEX,
        title: "Live parent",
        initialMessage: "Run two agents and stream tool output",
      })
    ).thread!.id;
    turn = (
      await eventually(
        () =>
          store.query<{ id: string; status: string }>("SELECT id,status FROM turns WHERE thread_id=$1::uuid", [thread]),
        (rows) => rows[0]?.status === "running",
      )
    )[0]!.id;
    await store.query(
      `INSERT INTO thread_items(thread_id,item_id,type,status,content,first_seq,last_seq)
      SELECT $1::uuid,'history-' || n,'agentMessage','completed',
      jsonb_build_object('itemId','history-' || n,'agentMessage',jsonb_build_object('text',repeat('history ',100))),n,n
      FROM generate_series(1,1000) n`,
      [thread],
    );
    await store.query("UPDATE threads SET last_seq=1000 WHERE id=$1::uuid", [thread]);
    network = new NetworkAccess({ store, host: "127.0.0.1" });
    gateway.core.network = network;
    unmount = mountMobileNetwork(gateway.core, network, SERVICE_TOKEN);
    await network.start();
    await network.update(create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: true }));
    const routes = gateway.core.mobile.networkRoutes();
    const transport = nodePinnedTransport();
    const invite = await gateway.api.createMobilePairing({});

    const paired = await routedMobileClient({ connection: routes, transport }).pairing.exchangeMobilePairing({
      code: invite.code,
      name: "Live update phone",
      platform: "ios",
    });

    phone = routedMobileClient({ connection: routes, transport, token: paired.deviceToken });
  }, 30_000);
  afterAll(async () => {
    unmount?.();
    await network?.close();
    await gateway?.close();
  });

  test("gRPC and mobile stay connected while tools grow and two subagents steer messages", async () => {
    const abort = new AbortController();
    const states: (ui.ThreadSnapshot | undefined)[] = [];
    const ready = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const finished = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];

    const streams = [gateway.api, phone.api].map(async (api, index) => {
      try {
        for await (const update of api.watchThread(
          { threadId: thread, sequence: true },
          {
            signal: abort.signal,
            timeoutMs: 15_000,
          },
        )) {
          if (update.change.case === "batch") {
            validateThreadBatch(update.change.value, states[index]!.syncCursor!.appliedSeq);
            expect(toBinary(ui.ThreadUpdateSchema, update).length).toBeLessThanOrEqual(65_536);
          }

          states[index] = applyThreadUpdate(states[index], update);

          if (update.change.case === "snapshot") ready[index]!.resolve();

          if (states[index]?.thread?.title === "Live updates finished") finished[index]!.resolve();
        }
      } catch (error) {
        if (!abort.signal.aborted) {
          ready[index]!.reject(error);
          finished[index]!.reject(error);
          throw error;
        }
      }
    });

    try {
      await Promise.all(ready.map((entry) => entry.promise));

      for (let child = 0; child < 2; child++) {
        const spawned = await gateway.worker.callTool({
          threadId: thread,
          turnId: turn,
          tool: "spawn_thread",
          args: { title: `Child ${child}`, prompt: "Work", notify: false },
        });

        expect(spawned.isError).toBe(false);

        const children = await eventually(
          () =>
            store.query<{ id: string; turn: string; status: string }>(
              `SELECT t.id,u.id AS turn,u.status FROM threads t JOIN turns u ON u.thread_id=t.id
              WHERE t.parent_thread_id=$1::uuid ORDER BY t.created_at`,
              [thread],
            ),
          (rows) => rows.length === child + 1 && rows.every((row) => row.status === "running"),
        );

        const source = children[child]!;

        const sent = await gateway.worker.callTool({
          threadId: source.id,
          turnId: source.turn,
          tool: "send_message",
          args: { thread_id: thread, prompt: "Agent progress ".repeat(6000), delivery: "steer", notify: false },
        });

        expect(sent.isError).toBe(false);
      }

      gateway.worker.emit(thread, turn, {
        case: "itemStarted",
        value: {
          item: {
            itemId: "running-tool",
            status: ItemStatus.IN_PROGRESS,
            content: { case: "commandExecution", value: { command: "running script" } },
          },
        },
      });
      gateway.worker.emit(thread, turn, {
        case: "itemDelta",
        value: { itemId: "running-tool", field: ItemDeltaField.OUTPUT, chunk: "live output ".repeat(20000) },
      });

      for (let item = 0; item < 12; item++) {
        gateway.worker.emit(thread, turn, {
          case: "itemStarted",
          value: {
            item: {
              itemId: `tool-${item}`,
              status: ItemStatus.IN_PROGRESS,
              content: { case: "commandExecution", value: { command: "running script", output: "" } },
            },
          },
        });
        gateway.worker.emit(thread, turn, {
          case: "itemCompleted",
          value: {
            item: {
              itemId: `tool-${item}`,
              status: ItemStatus.COMPLETED,
              content: {
                case: "commandExecution",
                value: { command: "running script", output: "output ".repeat(20000) },
              },
            },
          },
        });
      }

      await eventually(
        () =>
          store.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM thread_items WHERE thread_id=$1::uuid AND item_id LIKE 'tool-%'",
            [thread],
          ),
        (rows) => rows[0]?.count === 12,
      );
      await gateway.api.updateThread({ threadId: thread, title: "Live updates finished" });
      await Promise.all(finished.map((entry) => entry.promise));

      for (const state of states) {
        expect(state?.steers.length).toBe(2);
        expect(state?.items.filter((item) => item.item?.itemId.startsWith("tool-")).length).toBe(12);
        expect(state?.items.some((item) => item.contentRef)).toBe(true);
        expect(state?.items.find((item) => item.item?.itemId === "running-tool")?.item?.status).toBe(
          ItemStatus.IN_PROGRESS,
        );
      }
    } finally {
      abort.abort();
      await Promise.allSettled(streams);
    }
  }, 25_000);
});
