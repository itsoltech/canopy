import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDir } from "@canopy/testing";
import { startConnectHttpServer } from "@canopy/transport";
import { Code, ConnectError, createClient, type HandlerContext } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import {
  streamThreadCreation,
  ThreadPreparationFailed,
} from "../../apps/mobile/src/features/new-thread/creation-stream.ts";
import { git, worktreeFixture } from "./support/worktrees.ts";

type StreamMode = "forward" | "legacy" | "unavailable" | "unimplemented" | "unfinished";

describe.skipIf(!dockerAvailable)("native thread creation over Connect and real worker links", () => {
  const dir = tempDir("canopy-mobile-thread-progress-");
  let f: Awaited<ReturnType<typeof worktreeFixture>>;

  beforeAll(async () => {
    f = await worktreeFixture(dir, {
      capabilities: ["worktree_progress_v1"],
      codexFixture: new URL("./fixtures/login-codex.ts", import.meta.url),
    });
    await f.settings({ startFromRemote: true });
  }, 60_000);

  afterAll(async () => {
    await f?.close();
  }, 30_000);

  const request = () =>
    create(ui.CreateThreadRequestSchema, {
      projectId: f.project.id,
      workspaceId: f.workspace.id,
      provider: Provider.CODEX,
      workspaceMode: ui.WorkspaceMode.NEW_WORKTREE,
      baseRef: "main",
      clientRequestId: Bun.randomUUIDv7(),
      draftId: Bun.randomUUIDv7(),
    });

  const delivery = (input: ui.CreateThreadRequest) =>
    f.gw.api.getComposerDraftDelivery({
      id: input.draftId,
      clientRequestId: input.clientRequestId,
      workspaceId: input.workspaceId,
    });

  // A real HTTP/1.1 boundary forwards to the gateway and can lose its final reply after admission.
  async function proxy(mode: StreamMode) {
    const calls = { stream: 0, unary: 0 };

    const server = await startConnectHttpServer({
      routes: (router) =>
        router.service(ui.GatewayService, {
          createThread: (input, context) => f.gw.api.createThread(input, { signal: context.signal }),
          ...(mode !== "legacy" && {
            async *createThreadWithProgress(input: ui.CreateThreadRequest, context: HandlerContext) {
              for await (const event of f.gw.api.createThreadWithProgress(input, { signal: context.signal })) {
                if (event.thread && mode !== "forward") {
                  if (mode === "unfinished") return;

                  throw new ConnectError(
                    "Final creation reply lost",
                    mode === "unimplemented" ? Code.Unimplemented : Code.Unavailable,
                  );
                }

                yield event;
              }
            },
          }),
        }),
    });

    const api = createClient(
      ui.GatewayService,
      createConnectTransport({
        baseUrl: server.url,
        httpVersion: "1.1",
        interceptors: [
          (next) => (input) => {
            if (input.method.name === "CreateThreadWithProgress") calls.stream++;

            if (input.method.name === "CreateThread") calls.unary++;

            return next(input);
          },
        ],
      }),
    );

    return { api, calls, close: () => server.close(0) };
  }

  test("native helper reports real Git progress and settles a draft before returning its thread", async () => {
    const transport = await proxy("forward");
    const input = request();
    const events: ui.CreateThreadProgress[] = [];

    try {
      const result = await streamThreadCreation(
        transport.api,
        input,
        (event) => events.push(event),
        AbortSignal.timeout(15_000),
      );

      expect(events).toContainEqual(expect.objectContaining({ step: "fetch_remote", status: "running" }));
      expect(events).toContainEqual(expect.objectContaining({ step: "fetch_remote", status: "completed" }));
      expect(events).toContainEqual(expect.objectContaining({ step: "create_worktree", status: "running" }));
      expect(events.at(-1)).toMatchObject({ step: "start_thread", status: "completed", thread: result.thread });
      expect(events.slice(0, -1).every((event) => !event.thread)).toBe(true);
      const thread = result.thread!;
      expect(thread.cwd).not.toBe(f.repo);
      expect(thread.worktree?.path).toBe(thread.cwd);
      expect(git(f.repo, "symbolic-ref", "--short", "HEAD")).toBe("main");
      expect((await delivery(input)).confirmed).toBe(true);
      expect(transport.calls).toEqual({ stream: 1, unary: 0 });
      await f.settled(thread);

      const replay = await streamThreadCreation(transport.api, input, () => {}, AbortSignal.timeout(15_000));
      expect(replay.thread?.id).toBe(thread.id);
      expect((await f.gw.api.listThreads({ projectId: input.projectId })).threads).toHaveLength(1);
      expect(transport.calls).toEqual({ stream: 2, unary: 0 });
    } finally {
      await transport.close();
    }
  }, 25_000);

  test("failed worker preparation reaches the callback and leaves a failed thread without confirming delivery", async () => {
    const transport = await proxy("forward");
    const input = create(ui.CreateThreadRequestSchema, { ...request(), baseRef: "missing-mobile-base" });
    const events: ui.CreateThreadProgress[] = [];

    try {
      const error = await streamThreadCreation(
        transport.api,
        input,
        (event) => events.push(event),
        AbortSignal.timeout(15_000),
      ).then(
        () => undefined,
        (cause: unknown) => cause,
      );

      expect(error).toBeInstanceOf(ThreadPreparationFailed);
      expect(error).toMatchObject({ code: Code.Aborted });
      expect(events.at(-1)).toMatchObject({ step: "check_workspace", status: "failed" });
      expect(events.at(-1)?.detail).toContain("not a branch or commit");
      expect(events.some((event) => event.thread)).toBe(false);
      const result = await delivery(input);

      expect(result).toMatchObject({ confirmed: false, inFlight: false });
      expect((await f.gw.api.getThread({ threadId: result.threadId })).thread).toMatchObject({
        status: "failed",
        preparationRequestId: input.clientRequestId,
      });
      expect(transport.calls).toEqual({ stream: 1, unary: 0 });
    } finally {
      await transport.close();
    }
  }, 20_000);

  test("an older HTTP gateway falls back once to unary with the same draft request", async () => {
    const transport = await proxy("legacy");
    const input = request();
    const events: ui.CreateThreadProgress[] = [];

    try {
      const result = await streamThreadCreation(
        transport.api,
        input,
        (event) => events.push(event),
        AbortSignal.timeout(15_000),
      );

      expect(events.map((event) => `${event.step}:${event.status}`)).toEqual([
        "start_thread:running",
        "start_thread:completed",
      ]);
      expect(result.thread?.worktree?.path).toBe(result.thread?.cwd);
      expect(events.at(-1)?.thread?.id).toBe(result.thread?.id);
      expect((await delivery(input)).confirmed).toBe(true);
      expect(transport.calls).toEqual({ stream: 1, unary: 1 });
      await f.settled(result.thread!);
    } finally {
      await transport.close();
    }
  }, 20_000);

  test("receipt settlement failure stays uncertain and read-only recovery finds the admitted thread", async () => {
    const transport = await proxy("forward");

    const input = create(ui.CreateThreadRequestSchema, {
      ...request(),
      initialMessage: "Admission survives receipt failure",
    });

    const events: ui.CreateThreadProgress[] = [];
    const before = await f.gw.api.listThreads({ projectId: input.projectId });
    await f.sql(
      (sql) => sql`CREATE FUNCTION reject_mobile_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Synthetic receipt write failure'; END; $$`,
    );

    try {
      await f.sql(
        (sql) => sql`CREATE TRIGGER reject_mobile_settlement BEFORE UPDATE ON composer_drafts
        FOR EACH ROW WHEN (NEW.sent) EXECUTE FUNCTION reject_mobile_settlement()`,
      );

      try {
        const error = await streamThreadCreation(
          transport.api,
          input,
          (event) => events.push(event),
          AbortSignal.timeout(15_000),
        ).then(
          () => undefined,
          (cause: unknown) => cause,
        );

        expect(error).toBeInstanceOf(ConnectError);
        expect(error).toMatchObject({ code: Code.Unknown });
        expect(events.at(-1)).toMatchObject({ step: "start_thread", status: "failed" });
        expect(events.some((event) => event.thread)).toBe(false);
        expect(transport.calls).toEqual({ stream: 1, unary: 0 });
      } finally {
        await f.sql((sql) => sql`DROP TRIGGER reject_mobile_settlement ON composer_drafts`);
      }

      const recovered = await delivery(input);
      expect(recovered).toMatchObject({ confirmed: true, inFlight: false });
      expect(recovered.threadId).toBeTruthy();
      const thread = (await f.gw.api.getThread({ threadId: recovered.threadId })).thread!;
      await f.settled(thread);
      expect(await delivery(input)).toEqual(recovered);
      const threads = (await f.gw.api.listThreads({ projectId: input.projectId })).threads;
      expect(threads).toHaveLength(before.threads.length + 1);
      expect(threads.filter((entry) => entry.id === thread.id)).toHaveLength(1);
      expect(transport.calls).toEqual({ stream: 1, unary: 0 });
    } finally {
      await f.sql((sql) => sql`DROP FUNCTION reject_mobile_settlement()`);
      await transport.close();
    }
  }, 20_000);

  test("lost or missing final replies preserve admission without automatic unary retries", async () => {
    for (const [mode, code] of [
      ["unavailable", Code.Unavailable],
      ["unimplemented", Code.Unimplemented],
      ["unfinished", Code.Unknown],
    ] as const) {
      const transport = await proxy(mode);
      const input = request();
      const events: ui.CreateThreadProgress[] = [];
      const before = await f.gw.api.listThreads({ projectId: input.projectId });

      try {
        const error = await streamThreadCreation(
          transport.api,
          input,
          (event) => events.push(event),
          AbortSignal.timeout(15_000),
        ).then(
          () => undefined,
          (cause: unknown) => cause,
        );

        expect(error).toBeInstanceOf(ConnectError);
        expect(error).toMatchObject({ code });
        expect(events).toContainEqual(expect.objectContaining({ step: "create_worktree", status: "completed" }));
        expect(events.some((event) => event.thread)).toBe(false);
        expect(transport.calls).toEqual({ stream: 1, unary: 0 });
        // Recover by reading the durable admission identity; never replay a creation mutation.
        const recovered = await delivery(input);
        expect(recovered).toMatchObject({ confirmed: true, inFlight: false });
        expect(recovered.threadId).toBeTruthy();
        const thread = (await f.gw.api.getThread({ threadId: recovered.threadId })).thread!;
        await f.settled(thread);
        const threads = (await f.gw.api.listThreads({ projectId: input.projectId })).threads;
        expect(threads).toHaveLength(before.threads.length + 1);
        expect(threads.filter((entry) => entry.id === thread.id)).toHaveLength(1);
        expect(transport.calls).toEqual({ stream: 1, unary: 0 });
      } finally {
        await transport.close();
      }
    }
  }, 50_000);
});
