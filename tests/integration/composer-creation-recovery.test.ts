import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { MentionKind, MentionSchema, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { nodeRef } from "@canopy/domain/computers";
import { GatewayCore } from "@canopy/gateway/core";
import { serviceTokenAuth, uiHandlers } from "@canopy/gateway/api";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDir } from "@canopy/testing";
import { startGrpcServer } from "@canopy/transport";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { routed } from "../../apps/gateway/src/api/routed.ts";
import { withDraftDelivery } from "../../apps/gateway/src/drafts/delivery.ts";
import { reconcileDraftDelivery } from "../../apps/gateway/src/drafts/reconcile.ts";
import { creationEvent } from "../../apps/gateway/src/core/thread-progress.ts";
import { streamThreadCreation } from "../../apps/mobile/src/features/new-thread/creation-stream.ts";
import { eventually, SERVICE_TOKEN, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { linkedProjectFixture } from "./support/linked-projects.ts";
import { git } from "./support/worktrees.ts";

async function canceledCreation(fixture: Awaited<ReturnType<typeof linkedProjectFixture>>, remote: boolean) {
  const { a, b, lb } = fixture;
  const home = remote ? b : a;
  const suffix = remote ? `~${nodeRef(lb.hello().nodeId)}` : "";
  const hooks = join(home.dir, "recovery-checkout-hooks");
  mkdirSync(hooks);
  writeFileSync(
    join(hooks, "post-checkout"),
    '#!/bin/sh\ntouch "$0.entered"\nwhile [ ! -f "$0.release" ]; do sleep 0.02; done\n',
    {
      mode: 0o755,
    },
  );
  // The hook blocks the actual checkout until recovery has inspected the active receipt.
  const enteredHook = join(hooks, "post-checkout.entered");
  const releaseHook = join(hooks, "post-checkout.release");
  const aborted = Promise.withResolvers<void>();
  const ended = Promise.withResolvers<void>();
  const routing = routed(a.gw.core, uiHandlers(a.gw.core));

  const handlers = withDraftDelivery(a.gw.core, {
    ...routing,
    async *createThreadWithProgress(request, context) {
      try {
        yield* routing.createThreadWithProgress(request, context);
      } finally {
        ended.resolve();
      }
    },
  });

  const server = await startGrpcServer({
    routes: (router) =>
      router.service(ui.GatewayService, {
        async *createThreadWithProgress(request, context) {
          context.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
          yield* handlers.createThreadWithProgress(request, context);
        },
      }),
    interceptors: [serviceTokenAuth(SERVICE_TOKEN)],
    host: "127.0.0.1",
    port: 0,
  });

  const api = createClient(
    ui.GatewayService,
    createGrpcTransport({
      baseUrl: server.url,
      interceptors: [
        (next) => (request) => {
          request.header.set("authorization", `Bearer ${SERVICE_TOKEN}`);

          return next(request);
        },
      ],
    }),
  );

  const input = {
    projectId: `${home.project.id}${suffix}`,
    workspaceId: `${home.workspace.id}${suffix}`,
    provider: Provider.CODEX,
    workspaceMode: ui.WorkspaceMode.NEW_WORKTREE,
    baseRef: "main",
    clientRequestId: crypto.randomUUID(),
    draftId: crypto.randomUUID(),
  };

  const lookup = { id: input.draftId, workspaceId: input.workspaceId, clientRequestId: input.clientRequestId };
  const controller = new AbortController();

  const beforeWorktrees = git(home.repo, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree ")).length;

  git(home.repo, "config", "core.hooksPath", hooks);
  const watching = Array.fromAsync(api.createThreadWithProgress(input, { signal: controller.signal })).catch(() => []);

  try {
    expect(await eventually(async () => existsSync(enteredHook), Boolean)).toBe(true);
    controller.abort();
    await aborted.promise;
    await watching;
    expect(await a.gw.api.getComposerDraftDelivery(lookup)).toMatchObject({ confirmed: false, inFlight: true });
    expect(await Promise.race([ended.promise.then(() => "ended"), Bun.sleep(100).then(() => "held")])).toBe("held");
    expect(await a.gw.api.getComposerDraftDelivery(lookup)).toMatchObject({ confirmed: false, inFlight: true });
    writeFileSync(releaseHook, "");

    const result = await eventually(
      () => a.gw.api.getComposerDraftDelivery(lookup),
      (delivery) => delivery.confirmed,
    );

    expect(result.confirmed).toBe(true);
    expect(result.inFlight).toBe(false);
    const thread = (await a.gw.api.getThread({ threadId: result.threadId })).thread!;
    expect(thread.worktree).toBeDefined();
    expect(thread.id).toBe(`${thread.id.split("~")[0]}${suffix}`);
    await home.settled((await home.gw.api.getThread({ threadId: thread.id.split("~")[0] })).thread!);

    const rows = await home.sql(
      (sql) => sql<{ count: number }>`SELECT count(*)::int AS count FROM threads
      WHERE creation_request_id=${input.clientRequestId}`,
    );

    expect(rows[0]?.count).toBe(1);
    const worktrees = git(home.repo, "worktree", "list", "--porcelain").split("\n");
    expect(worktrees.filter((line) => line.startsWith("worktree "))).toHaveLength(beforeWorktrees + 1);
    expect(worktrees.filter((line) => line === `worktree ${thread.cwd}`)).toHaveLength(1);
  } finally {
    controller.abort();
    writeFileSync(releaseHook, "");
    await watching;
    await ended.promise;
    git(home.repo, "config", "--unset", "core.hooksPath");
    await server.close();
  }
}

describe.skipIf(!dockerAvailable)("read-only creation recovery", () => {
  let gw: TestGateway;
  let projectId: string;
  let workspaceId: string;

  beforeAll(async () => {
    gw = await startTestGateway();
    const project = (await gw.api.getOverview({})).projects[0]!;
    projectId = project.id;
    workspaceId = project.workspaces[0]!.id;
  }, 60_000);

  afterAll(async () => {
    await gw?.close();
  });

  const request = (initialMessage = "") => ({
    projectId,
    workspaceId,
    provider: Provider.CODEX,
    initialMessage,
    initialMentions: initialMessage.startsWith("/goal ")
      ? [create(MentionSchema, { kind: MentionKind.COMMAND, name: "goal", source: "platform", start: 0, end: 5 })]
      : [],
    clientRequestId: crypto.randomUUID(),
    draftId: crypto.randomUUID(),
  });

  const delivery = (input: ReturnType<typeof request>, id = input.draftId) =>
    gw.api.getComposerDraftDelivery({ id, clientRequestId: input.clientRequestId, workspaceId });

  test("an inner stream ending after preparation stays uncertain and recovers its admitted thread", async () => {
    const local = uiHandlers(gw.core);

    const handlers = withDraftDelivery(gw.core, {
      ...local,
      async *createThreadWithProgress(input, context) {
        yield creationEvent("prepare_message", "running");
        // Model a lost final response: admission commits, but the progress stream
        // closes without publishing its thread or an explicit preparation failure.
        await local.createThread(input, context);
      },
    });

    const server = await startGrpcServer({
      routes: (router) => router.service(ui.GatewayService, handlers),
      interceptors: [serviceTokenAuth(SERVICE_TOKEN)],
      host: "127.0.0.1",
      port: 0,
    });

    const api = createClient(
      ui.GatewayService,
      createGrpcTransport({
        baseUrl: server.url,
        interceptors: [
          (next) => (input) => {
            input.header.set("authorization", `Bearer ${SERVICE_TOKEN}`);

            return next(input);
          },
        ],
      }),
    );

    const input = request("Admitted initial message after preparation");
    const events: ui.CreateThreadProgress[] = [];

    try {
      const error = await streamThreadCreation(
        api,
        create(ui.CreateThreadRequestSchema, input),
        (event) => events.push(event),
        AbortSignal.timeout(5000),
      ).then(
        () => undefined,
        (cause: unknown) => ConnectError.from(cause),
      );

      expect(error?.code).toBe(Code.Unknown);
      expect(events.at(-1)).toMatchObject({ step: "start_thread", status: "failed" });
      expect(events.some((event) => event.thread)).toBe(false);
      const createThread = gw.core.createThread;
      gw.core.createThread = () => {
        throw new Error("Uncertain progress must recover without replaying admission");
      };

      try {
        const result = await delivery(input);
        expect(result.confirmed).toBe(true);
        expect(result.threadId).not.toBe("");
        expect((await gw.api.getThread({ threadId: result.threadId })).thread?.id).toBe(result.threadId);
      } finally {
        gw.core.createThread = createThread;
      }
    } finally {
      await server.close();
    }
  });

  test("sent /goal and empty creations recover identity without replay or an initial turn", async () => {
    for (const text of ["/goal Finish native recovery", ""]) {
      const input = request(text);
      const thread = (await gw.api.createThread(input)).thread!;

      const turns = await gw.runtime.runPromise(
        Effect.flatMap(SqlClient.SqlClient, (sql) => sql`SELECT id FROM turns WHERE thread_id=${thread.id}::uuid`),
      );

      expect(turns).toHaveLength(0);
      const createThread = gw.core.createThread;
      gw.core.createThread = () => {
        throw new Error("Recovery must never replay thread creation");
      };

      try {
        expect(await delivery(input)).toMatchObject({ confirmed: true, inFlight: false, threadId: thread.id });
        expect(await delivery(input)).toMatchObject({ confirmed: true, threadId: thread.id });
        // A matching row alone cannot establish admission without its receipt.
        expect(await delivery(input, "")).toMatchObject({ confirmed: false });
      } finally {
        gw.core.createThread = createThread;
      }
    }
  });

  test("a matching initial turn confirms a creation even when its receipt is unavailable", async () => {
    const input = request("Recover the admitted initial message");
    const thread = (await gw.api.createThread(input)).thread!;

    expect(await delivery(input, "")).toMatchObject({ confirmed: true, threadId: thread.id });
    expect(await gw.api.getComposerDraftDelivery({ clientRequestId: crypto.randomUUID(), workspaceId })).toMatchObject({
      confirmed: false,
      threadId: "",
    });
    expect(
      await gw.api.getComposerDraftDelivery({ threadId: thread.id, clientRequestId: input.clientRequestId }),
    ).toMatchObject({ confirmed: true, threadId: thread.id });
  });

  test("a no-turn creation with an active unsent receipt stays unconfirmed", async () => {
    const input = request();
    const thread = (await gw.api.createThread(input)).thread!;
    await gw.runtime.runPromise(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql`UPDATE composer_drafts SET sent=false,send_active_until=now()+interval '1 minute'
          WHERE id=${input.draftId}::uuid`,
      ),
    );

    expect(await delivery(input)).toMatchObject({ confirmed: false, inFlight: true });

    const receipts = await gw.runtime.runPromise(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql<{ sent: boolean }>`SELECT sent FROM composer_drafts WHERE id=${input.draftId}::uuid`,
      ),
    );

    expect(receipts[0]?.sent).toBe(false);
    expect((await gw.api.getThread({ threadId: thread.id })).thread?.id).toBe(thread.id);
  });

  test("foreign owners cannot recover another owner's receipt or creation identity", async () => {
    const input = request("/goal Private recovery");
    await gw.api.createThread(input);

    const userId = await gw.runtime.runPromise(
      GatewayStore.use((store) => store.ensureUser("recovery-other@example.test", "Other")),
    );

    const other = new GatewayCore({ runtime: gw.runtime, userId, instanceId: "recovery-other" });

    try {
      const result = await reconcileDraftDelivery(
        other,
        create(ui.GetComposerDraftDeliveryRequestSchema, {
          id: input.draftId,
          clientRequestId: input.clientRequestId,
          workspaceId,
        }),
        AbortSignal.timeout(2000),
      );

      expect(result).toMatchObject({ confirmed: false, inFlight: false, threadId: "" });
    } finally {
      await other.stopSweep();
    }
  });

  test("a sent receipt remains confirmed after its created thread is deleted", async () => {
    const input = request();
    const thread = (await gw.api.createThread(input)).thread!;
    await gw.api.deleteThread({ threadId: thread.id });

    expect(await delivery(input)).toMatchObject({ confirmed: true, threadId: "" });
  });
});

describe.skipIf(!dockerAvailable)("linked creation recovery", () => {
  const directory = tempDir("canopy-creation-recovery-linked-");
  let fixture: Awaited<ReturnType<typeof linkedProjectFixture>>;

  beforeAll(async () => {
    fixture = await linkedProjectFixture(directory, { shared: true, worktreeProgress: true });
  }, 60_000);

  afterAll(async () => {
    await fixture?.close();
  });

  test("the local sent receipt recovers the qualified peer identity without an initial turn", async () => {
    const { a, b, lb } = fixture;
    const node = nodeRef(lb.hello().nodeId);

    const input = {
      projectId: `${b.project.id}~${node}`,
      workspaceId: `${b.workspace.id}~${node}`,
      provider: Provider.CODEX,
      initialMessage: "/goal Recover a linked creation",
      initialMentions: [
        create(MentionSchema, { kind: MentionKind.COMMAND, name: "goal", source: "platform", start: 0, end: 5 }),
      ],
      clientRequestId: crypto.randomUUID(),
      draftId: crypto.randomUUID(),
    };

    const thread = (await a.gw.api.createThread(input)).thread!;
    const lookup = { id: input.draftId, workspaceId: input.workspaceId, clientRequestId: input.clientRequestId };
    const createThread = b.gw.core.createThread;
    b.gw.core.createThread = () => {
      throw new Error("Recovery must never replay remote creation");
    };

    try {
      expect(await a.gw.api.getComposerDraftDelivery(lookup)).toMatchObject({
        confirmed: true,
        threadId: thread.id,
      });
      expect(thread.id).toEndWith(`~${node}`);
      expect(await a.gw.api.getComposerDraftDelivery({ ...lookup, id: "" })).toMatchObject({ confirmed: false });

      const rows = await b.sql(
        (sql) => sql<{ turns: number; receipts: number }>`SELECT
          (SELECT count(*)::int FROM turns WHERE client_request_id=${input.clientRequestId}) AS turns,
          (SELECT count(*)::int FROM composer_drafts WHERE delivery_request_id=${input.clientRequestId}) AS receipts`,
      );

      expect(rows[0]).toEqual({ turns: 0, receipts: 0 });
    } finally {
      b.gw.core.createThread = createThread;
    }
  }, 20_000);

  test("a canceled draft stream keeps local and linked checkout receipts active until settlement", async () => {
    await canceledCreation(fixture, false);
    await canceledCreation(fixture, true);
  }, 30_000);
});
