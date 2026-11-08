/** Pending native interactions survive a broken gRPC link while the same worker process keeps running. */
import { afterAll, beforeAll, describe, expect, spyOn, test, type Mock } from "bun:test";
import { Code } from "@connectrpc/connect";
import { join, resolve } from "node:path";
import { PermissionMode, Provider, ui, type InteractionRequest } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore, Ingest } from "@canopy/gateway/store";
import { tempDir } from "@canopy/testing";
import { journalHello, openGatewayLink, resendPending, type GatewayLink } from "@canopy/worker/gateway-link";
import { Journal } from "@canopy/worker/journal";
import { serveLink, WorkerHost } from "@canopy/worker/runtime";
import { ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { HostEvents } from "../../apps/worker/src/runtime/host-events.ts";
import { eventually, startTestGateway, watchUntil, type TestGateway } from "./support/gateway.ts";

const dir = tempDir("canopy-interaction-reconnect-");
const fake = resolve(import.meta.dir, "../../apps/worker/src/providers/grok/fixtures/agent.ts");
let gw: TestGateway;
let edge: { workerId: string; credential: string };
let host: WorkerHost;
let runtime: ManagedRuntime.ManagedRuntime<Journal, unknown>;
let link: GatewayLink;
let serving: Promise<unknown>;
let workspaceId = "";
let projectId = "";
let interactions: Mock<HostEvents["interact"]>;
let abandoned: AbortSignal | undefined;

const query = <A extends object>(statement: string, ...params: string[]) =>
  gw.runtime.runPromise(SqlClient.SqlClient.use((sql) => sql.unsafe<A>(statement, params)));

async function snapshot(threadId: string): Promise<ui.ThreadSnapshot> {
  const updates = await watchUntil(gw.api, threadId, (us) => us.some((u) => u.change.case === "snapshot"));

  for (const update of updates) if (update.change.case === "snapshot") return update.change.value;
  throw new Error("thread snapshot missing");
}

async function connect() {
  link = await openGatewayLink({
    baseUrl: gw.grpcUrl,
    credential: edge.credential,
    hello: {
      workerId: edge.workerId,
      capabilities: ["running_turns"],
      runningTurns: host.runningTurns(),
      ...(await runtime.runPromise(journalHello())),
    },
  });
  await runtime.runPromise(resendPending(link, (event) => host.sendPreviews(link, event)));
  serving = serveLink(link, host, runtime);
  expect(
    await eventually(
      () => gw.api.getOverview({}),
      (o) => o.workers.some((w) => w.id === edge.workerId && w.providerInstances.some((i) => i.available)),
      15_000,
    ),
  ).toMatchObject({ workers: expect.arrayContaining([expect.objectContaining({ id: edge.workerId })]) });
}

async function disconnected() {
  await serving;
  await link.closed;
  expect(
    await eventually(
      async () => gw.core.online.has(edge.workerId),
      (online) => !online,
    ),
  ).toBe(false);
}

async function disconnect() {
  link.close();
  await disconnected();
}

async function thread(title: string) {
  const created = (
    await gw.api.createThread({
      projectId,
      workspaceId,
      title,
      provider: Provider.GROK,
      model: "fake-grok",
      permissionMode: PermissionMode.ASK,
      clientRequestId: crypto.randomUUID(),
    })
  ).thread!;

  expect(
    await eventually(
      () => gw.api.getThread({ threadId: created.id }),
      (r) => r.thread?.status === "idle",
    ),
  ).toMatchObject({ thread: { status: "idle" } });

  return created.id;
}

async function ask(threadId: string) {
  const sent = await gw.api.sendMessage({ threadId, text: "PERMISSION", clientRequestId: crypto.randomUUID() });

  return sent.turn!.id;
}

async function pending(threadId: string) {
  const state = await eventually(
    () => snapshot(threadId),
    // Snapshot queries can straddle the interaction commit: wait for its timeline item too.
    (s) =>
      s.interactions.some(
        (interaction) =>
          interaction.status === "pending" &&
          s.items.some(
            (i) =>
              i.item?.content.case === "interactionPrompt" && i.item.content.value.requestId === interaction.requestId,
          ),
      ),
  );

  expect(state.interactions).toHaveLength(1);
  expect(state.interactions[0]?.status).toBe("pending");
  expect(state.items.filter((i) => i.item?.content.case === "interactionPrompt")).toHaveLength(1);

  return state.interactions[0]!;
}

async function timeline(request: InteractionRequest | ui.Interaction, answered = false) {
  const counts = await query<{ requests: number; items: number; starts: number; ends: number }>(
    `SELECT
       (SELECT count(*)::int FROM interaction_requests WHERE id = $1::uuid) AS requests,
       (SELECT count(*)::int FROM thread_items WHERE thread_id = $2::uuid AND item_id = 'interaction-' || $1) AS items,
       count(*) FILTER (WHERE kind = 'item_started')::int AS starts,
       count(*) FILTER (WHERE kind = 'item_completed')::int AS ends
     FROM thread_events WHERE thread_id = $2::uuid AND item_id = 'interaction-' || $1`,
    request.requestId,
    request.threadId,
  );

  expect(counts).toEqual([{ requests: 1, items: 1, starts: 1, ends: answered ? 1 : 0 }]);
}

async function continued(request: ui.Interaction) {
  const state = await eventually(
    () => snapshot(request.threadId),
    (s) => s.turns.some((t) => t.id === request.turnId && t.status === "completed"),
  );

  expect(state.turns.find((t) => t.id === request.turnId)?.status).toBe("completed");
  expect(state.interactions).toEqual([]);
  expect(
    state.items.flatMap((i) => (i.item?.content.case === "agentMessage" ? [i.item.content.value.text] : [])),
  ).toEqual(["ALLOWED"]);
  await timeline(request, true);
}

describe.skipIf(!dockerAvailable)("native interactions across worker reconnects (real WorkerHost + fake ACP)", () => {
  beforeAll(async () => {
    gw = await startTestGateway();
    edge = await gw.runtime.runPromise(
      GatewayStore.use((s) => s.addWorker({ name: "Interaction reconnect", ownerUserId: gw.userId })),
    );
    await gw.runtime.runPromise(
      GatewayStore.use((s) =>
        s.setWorkerConfig(edge.workerId, { grok: { enabled: true, executablePath: fake } }, gw.userId),
      ),
    );
    runtime = ManagedRuntime.make(Journal.layer(join(dir, "journal.db")));
    // HostContext binds this callback during construction; observe it before the real host captures it.
    const interact = HostEvents.prototype.interact;
    interactions = spyOn(HostEvents.prototype, "interact").mockImplementation(function (
      this: HostEvents,
      request,
      signal,
    ) {
      return interact.call(
        this,
        request,
        abandoned ? AbortSignal.any([abandoned, ...(signal ? [signal] : [])]) : signal,
      );
    });
    host = new WorkerHost({
      runtime,
      dataDir: join(dir, "data"),
      clientVersion: "test",
      deviceHomes: { claude: join(dir, "claude"), codex: join(dir, "codex") },
      probe: { which: () => fake, version: () => "grok 1.0.70", realDirectory: (p) => p, login: () => "Fake Grok" },
    });
    await connect();
    projectId = (await gw.api.createProject({ name: "Interaction reconnect" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: edge.workerId, rootPath: dir })).workspace!.id;
  }, 60_000);

  afterAll(async () => {
    link?.close();
    await serving;
    await host?.close();
    interactions?.mockRestore();
    await runtime?.dispose();
    await gw?.close();
    // Closing the worker host, runtime and gateway can outlast bun's 5 s hook default on a busy CI runner.
  }, 30_000);

  test("a provider request made offline reaches the UI once; repeated reconnects do not duplicate its timeline", async () => {
    const threadId = await thread("asks offline");
    const received = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const handle = host.handleCommand.bind(host);

    const commands = spyOn(host, "handleCommand").mockImplementation(async (command) => {
      if (command.kind.case === "startTurn") {
        received.resolve();
        await release.promise;
      }

      return handle(command);
    });

    try {
      const turnId = await ask(threadId);
      await received.promise;
      await disconnect();
      release.resolve();

      const request = await eventually(
        async () => interactions.mock.calls.find(([r]) => r.threadId === threadId)?.[0],
        (r) => !!r,
      );

      expect(request).toMatchObject({ threadId, turnId });
      expect(host.runningTurns()).toContainEqual({ threadId, turnId });
      expect((await snapshot(threadId)).interactions).toEqual([]);
      await connect();
      const interaction = await pending(threadId);
      expect(interaction.requestId).toBe(request!.requestId);
      await timeline(interaction);
      await disconnect();
      await connect();
      expect((await pending(threadId)).requestId).toBe(interaction.requestId);
      await timeline(interaction);
      await gw.api.answerInteraction({ requestId: interaction.requestId, allow: true });
      await continued(interaction);
    } finally {
      release.resolve();
      commands.mockRestore();
    }
  }, 30_000);

  test("an answer stored while the worker is offline resumes the provider after reconnect", async () => {
    const threadId = await thread("answers offline");
    await ask(threadId);
    const interaction = await pending(threadId);
    await disconnect();
    await gw.api.answerInteraction({ requestId: interaction.requestId, allow: true, message: "Approved offline" });
    expect((await snapshot(threadId)).interactions).toEqual([]);
    expect(host.runningTurns()).toContainEqual({ threadId, turnId: interaction.turnId });
    const responses = spyOn(host, "handleInteractionResponse");

    try {
      await connect();
      await continued(interaction);
      expect(responses.mock.calls.map(([r]) => r)).toMatchObject([
        { requestId: interaction.requestId, allow: true, message: "Approved offline" },
      ]);
    } finally {
      responses.mockRestore();
    }
  }, 30_000);

  test("an answer lost at the send boundary is replayed once, and duplicate responses do not reach the provider twice", async () => {
    const threadId = await thread("answer lost in flight");
    await ask(threadId);
    const interaction = await pending(threadId);
    const connection = gw.core.link.connections.get(edge.workerId)!;
    const send = connection.send.bind(connection);
    let dropped = 0;

    const sending = spyOn(connection, "send").mockImplementation((payload) => {
      if (payload.case === "interactionResponse") {
        // Cut the link after coreSendAnswer attempts delivery, before the response enters the gRPC stream.
        dropped++;
        link.close();

        return;
      }

      send(payload);
    });

    const responses = spyOn(host, "handleInteractionResponse");

    try {
      await gw.api.answerInteraction({ requestId: interaction.requestId, allow: true });
      await disconnected();
      expect(dropped).toBe(1);
      expect(responses).not.toHaveBeenCalled();
      expect(host.runningTurns()).toContainEqual({ threadId, turnId: interaction.turnId });
      sending.mockRestore();
      await connect();
      await continued(interaction);
      expect(responses.mock.calls).toHaveLength(1);
      // Late duplicate delivery is harmless, including after another link is established.
      const answer = responses.mock.calls[0]![0];
      await disconnect();
      await connect();
      expect(responses.mock.calls).toHaveLength(1);
      gw.core.link.connections.get(edge.workerId)!.send({ case: "interactionResponse", value: answer });
      expect(
        await eventually(
          async () => responses.mock.calls.length,
          (n) => n === 2,
        ),
      ).toBe(2);
      await continued(interaction);
    } finally {
      sending.mockRestore();
      responses.mockRestore();
    }
  }, 30_000);

  test("a long outage and explicit sweep/settle preserve a permission while its worker turn runs", async () => {
    const threadId = await thread("long outage");
    await ask(threadId);
    const interaction = await pending(threadId);
    await disconnect();
    // Simulate a day without traffic, far beyond sweep's stale threshold, without a wall-clock sleep.
    await query("UPDATE threads SET updated_at = now() - interval '1 day' WHERE id = $1::uuid", threadId);
    await query("UPDATE turns SET started_at = now() - interval '1 day' WHERE id = $1::uuid", interaction.turnId);
    await query(
      "UPDATE interaction_requests SET created_at = now() - interval '1 day' WHERE id = $1::uuid",
      interaction.requestId,
    );
    expect(await gw.core.sweep()).not.toContain(threadId);
    await gw.runtime.runPromise(
      Ingest.use((i) => i.settle(threadId, "test: offline running turn", { staleSeconds: 0 })),
    );
    const expired = await gw.runtime.runPromise(GatewayStore.use((s) => s.expireEndedInteractions(threadId)));
    expect(expired).toEqual([]);
    expect((await pending(threadId)).requestId).toBe(interaction.requestId);
    expect(host.runningTurns()).toContainEqual({ threadId, turnId: interaction.turnId });
    await connect();
    expect((await pending(threadId)).requestId).toBe(interaction.requestId);
    await gw.api.answerInteraction({ requestId: interaction.requestId, allow: true });
    await continued(interaction);
  }, 30_000);

  test("a late native permission answer expires atomically before the settlement sweep", async () => {
    const threadId = await thread("permission ended before answer");
    await ask(threadId);
    const interaction = await pending(threadId);
    // Exercise the gap between storing the terminal worker event and settlement/broadcast.
    await query(
      "UPDATE turns SET status = 'interrupted', completed_at = now() WHERE id = $1::uuid",
      interaction.turnId,
    );
    await expect(gw.api.answerInteraction({ requestId: interaction.requestId, allow: true })).rejects.toMatchObject({
      code: Code.FailedPrecondition,
      rawMessage: "This request expired.",
    });
    expect(
      await query(
        "SELECT status, response, answered_by FROM interaction_requests WHERE id = $1::uuid",
        interaction.requestId,
      ),
    ).toEqual([{ status: "expired", response: null, answered_by: null }]);
    await gw.api.interruptThread({ threadId });
  }, 15_000);

  test("a provider abandoning an offline request expires it on reconnect and rejects a late answer", async () => {
    const abort = new AbortController();
    abandoned = abort.signal;

    try {
      const threadId = await thread("abandoned provider request");
      await ask(threadId);
      const interaction = await pending(threadId);
      await disconnect();
      abort.abort();
      await connect();

      const expired = await eventually(
        () =>
          query<{ status: string }>(
            "SELECT status FROM interaction_requests WHERE id = $1::uuid",
            interaction.requestId,
          ),
        (rows) => rows[0]?.status === "expired",
      );

      expect(expired).toEqual([{ status: "expired" }]);
      await expect(gw.api.answerInteraction({ requestId: interaction.requestId, allow: true })).rejects.toMatchObject({
        code: Code.FailedPrecondition,
        rawMessage: "This request expired.",
      });
      expect((await snapshot(threadId)).interactions).toEqual([]);
    } finally {
      abandoned = undefined;
    }
  }, 15_000);
});
