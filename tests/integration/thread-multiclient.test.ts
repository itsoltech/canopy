import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { Provider, TurnOutcome, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDir } from "@canopy/testing";
import { applyThreadUpdate } from "@canopy/domain/thread-snapshot";
import { DesktopHistoryCache } from "../../apps/desktop/src/history-cache.ts";
import { NetworkAccess } from "../../apps/gateway/src/network/network.ts";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { mountMobileNetwork } from "../../apps/gateway/src/network/devices.ts";
import { routedMobileClient } from "../../apps/mobile/src/api/routes.ts";
import { coalesceDeltas } from "../../apps/web/src/lib/server/coalesce.ts";
import { nodePinnedTransport } from "./support/phone.ts";
import { eventually, SERVICE_TOKEN, startTestGateway, type TestGateway } from "./support/gateway.ts";

async function follow(source: AsyncIterable<ui.ThreadUpdate>, abort: AbortController, base?: ui.ThreadSnapshot) {
  let state = base;
  let failure: unknown;
  const updates: ui.ThreadUpdate[] = [];

  const reading = (async () => {
    try {
      for await (const update of source) {
        state = applyThreadUpdate(state, update);
        updates.push(update);
      }
    } catch (error) {
      if (!abort.signal.aborted) failure = error;
    }
  })();

  await eventually(
    async () => updates.length,
    (count) => count > 0,
  );
  expect(failure).toBeUndefined();
  expect(state?.thread).toBeDefined();

  return {
    get state() {
      return state!;
    },
    updates,
    async until(predicate: (snapshot: ui.ThreadSnapshot) => boolean) {
      await eventually(async () => state!, predicate);
      expect(failure).toBeUndefined();
      expect(predicate(state!)).toBe(true);
    },
    async close() {
      abort.abort();
      await reading;
    },
  };
}

const hasAnswer = (state: ui.ThreadSnapshot, text: string) =>
  state.items.some((entry) => entry.item?.content.case === "agentMessage" && entry.item.content.value.text === text);

describe.skipIf(!dockerAvailable)("independent desktop and paired phone thread subscriptions", () => {
  let gateway: TestGateway;
  let network: NetworkAccess;
  let unmount: () => void;
  let phone: ReturnType<typeof routedMobileClient>;
  let threadId: string;
  const clients: Awaited<ReturnType<typeof follow>>[] = [];

  beforeAll(async () => {
    gateway = await startTestGateway({ role: "desktop", watchProbeMs: 100 });
    network = new NetworkAccess({
      store: new ComputerStore(gateway.runtime, gateway.userId, gateway.secretsKey),
      host: "127.0.0.1",
    });
    gateway.core.network = network;
    unmount = mountMobileNetwork(gateway.core, network, SERVICE_TOKEN);
    await network.start();
    await network.update(create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: true }));
    const routes = gateway.core.mobile.networkRoutes();
    const transport = nodePinnedTransport();
    const invitation = await gateway.api.createMobilePairing({});

    const paired = await routedMobileClient({ connection: routes, transport }).pairing.exchangeMobilePairing({
      code: invitation.code,
      name: "Concurrent phone",
      platform: "ios",
    });

    phone = routedMobileClient({ connection: routes, transport, token: paired.deviceToken });
    const project = (await gateway.api.createProject({ name: "Concurrent clients" })).project!;

    const workspace = (
      await gateway.api.createWorkspace({ projectId: project.id, workerId: gateway.workerId, rootPath: "/repo" })
    ).workspace!;

    threadId = (
      await gateway.api.createThread({
        projectId: project.id,
        workspaceId: workspace.id,
        provider: Provider.CODEX,
        title: "Concurrent conversation",
        clientRequestId: crypto.randomUUID(),
      })
    ).thread!.id;
  }, 60000);

  afterAll(async () => {
    for (const client of clients) await client.close();
    unmount?.();
    await network?.close();
    await gateway?.close();
  });

  async function desktop(base?: ui.ThreadSnapshot) {
    const abort = new AbortController();

    const client = await follow(
      coalesceDeltas(
        gateway.api.watchThread(
          { threadId, incremental: true, cursor: base?.cursor ?? "", pageSize: 24 },
          { signal: abort.signal },
        ),
      ),
      abort,
      base,
    );

    clients.push(client);

    return client;
  }

  async function mobile() {
    const abort = new AbortController();

    const client = await follow(
      phone.api.watchThread({ threadId, incremental: true, pageSize: 24 }, { signal: abort.signal }),
      abort,
    );

    clients.push(client);

    return client;
  }

  test.each(["abort", "return"] as const)(
    "late %s cleanup cannot disconnect the desktop while the phone stays live",
    async (first) => {
      const abort = new AbortController();
      // Suspend at the snapshot to deterministically model delayed transport cleanup after abort.
      const previous = gateway.core.watchThread(threadId, abort.signal, "", true);
      await previous.next();

      if (first === "abort") abort.abort();
      else await previous.return(undefined);
      const web = await desktop();

      if (first === "abort") await previous.return(undefined);
      else abort.abort();
      const mobileClient = await mobile();
      const text = `Desktop after ${first} with phone connected`;

      try {
        await gateway.api.sendMessage({
          threadId,
          text,
          clientRequestId: crypto.randomUUID(),
        });
        await mobileClient.until((state) => hasAnswer(state, `Echo: ${text}`));
        await web.until((state) => hasAnswer(state, `Echo: ${text}`));
        expect(web.state.lastSeq).toBe(mobileClient.state.lastSeq);
      } finally {
        await web.close();
        await mobileClient.close();
      }
    },
    15000,
  );

  test("persistent desktop resume converges across steers, parent questions, cancellation and phone reconnect", async () => {
    gateway.worker.holdTurns = true;
    const web = await desktop();
    let mobileClient = await mobile();
    const cache = new DesktopHistoryCache(tempDir("desktop-concurrent-"));
    const key = `thread_${threadId}`;

    try {
      const sent = await gateway.api.sendMessage({
        threadId,
        text: "Coordinate",
        clientRequestId: crypto.randomUUID(),
      });

      await web.until((state) => state.turns.some((turn) => turn.id === sent.turn?.id && turn.status === "running"));
      const parentTurn = web.state.turns.at(-1)!;
      await eventually(async () => gateway.worker.started.has(parentTurn.id), Boolean);

      const spawn = await gateway.worker.callTool({
        threadId,
        turnId: parentTurn.id,
        tool: "spawn_thread",
        args: { title: "SSO settings", prompt: "Check settings", notify: false },
      });

      expect(spawn.isError).toBe(false);
      const child = JSON.parse(spawn.content) as { thread_id: string; turn_id: string };
      await eventually(async () => gateway.worker.started.has(child.turn_id), Boolean);
      const questionId = crypto.randomUUID();

      const waiting = gateway.worker.callTool({
        threadId: child.thread_id,
        turnId: child.turn_id,
        callId: questionId,
        tool: "ask_user",
        args: { questions: [{ id: "sso", header: "SSO", question: "Which settings?", kind: "text" }], wait: true },
      });

      const questions = await eventually(
        () =>
          gateway.core.linkedAgents.query<{ id: string }>(
            "SELECT id FROM turns WHERE interaction_request_id=$1::uuid",
            [questionId],
          ),
        (rows) => rows.length === 1,
      );

      await phone.api.sendMessage({
        threadId,
        text: "Phone steer",
        clientRequestId: crypto.randomUUID(),
        delivery: ui.MessageDelivery.STEER,
      });
      await web.until((state) => state.steers.some((steer) => steer.status === "delivered"));
      const { generation } = await cache.read(key);
      await cache.write(generation, key, toBinary(ui.ThreadSnapshotSchema, web.state));
      await web.close();
      await gateway.api.interruptThread({ threadId });
      // Releasing the parent lets its queued question start; that next turn must not inherit the fixture hold.
      gateway.worker.holdTurns = false;
      gateway.worker.emit(threadId, parentTurn.id, {
        case: "turnFinished",
        value: { outcome: TurnOutcome.INTERRUPTED },
      });
      await mobileClient.until((state) =>
        state.turns.some((turn) => turn.id === questions[0]!.id && turn.status === "completed"),
      );
      await phone.api.answerInteraction({
        requestId: questionId,
        answerJson: JSON.stringify({ answers: [{ id: "sso", kind: "text", text: "Use defaults" }] }),
      });
      expect(JSON.parse((await waiting).content).status).toBe("answered");
      gateway.worker.finish(child.thread_id, child.turn_id, "Settings checked");
      await mobileClient.close();
      mobileClient = await mobile();

      const restored = fromBinary(
        ui.ThreadSnapshotSchema,
        (await new DesktopHistoryCache(cache.directory).read(key)).bytes!,
      );

      const resumed = await desktop(restored);

      const reply = await gateway.api.sendMessage({
        threadId,
        text: "Can you see my replies?",
        clientRequestId: crypto.randomUUID(),
      });

      const replied = (state: ui.ThreadSnapshot) =>
        hasAnswer(state, "Echo: Can you see my replies?") &&
        state.turns.some((turn) => turn.id === reply.turn!.id && turn.status === "completed");

      await mobileClient.until(replied);
      // Revision probes may legitimately resubscribe. Compare both clients after recovery and turn completion.
      await resumed.until(
        (state) =>
          replied(state) &&
          !resumed.updates.at(-1)?.syncing &&
          !mobileClient.updates.at(-1)?.syncing &&
          Bun.deepEquals(state.items, mobileClient.state.items) &&
          Bun.deepEquals(state.turns, mobileClient.state.turns),
      );
      expect(resumed.state.items).toEqual(mobileClient.state.items);
      expect(resumed.state.turns).toEqual(mobileClient.state.turns);
      expect(resumed.updates.at(-1)?.syncing).toBe(false);
      await resumed.close();
    } finally {
      gateway.worker.holdTurns = false;
      await web.close();
      await mobileClient.close();
    }
  }, 20000);
});
