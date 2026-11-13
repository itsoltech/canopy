import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createClient, Code, ConnectError } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { ThreadWatchRecovery, threadUpdateFailure, readThreadWatchFailure } from "@canopy/domain/thread-watch-recovery";
import { ConnectionRecovery } from "@canopy/domain/connection-recovery";
import { applyThreadUpdate } from "@canopy/domain/thread-snapshot";
import { THREAD_BATCH_BYTES } from "@canopy/domain/thread-sync";
import { startGrpcServer, startConnectHttpServer } from "@canopy/transport";
import { mobileClient } from "../../apps/mobile/src/api/client.ts";
import { runStream } from "../../apps/mobile/src/state/stream-loop.ts";
import { sseResponse } from "../../apps/web/src/lib/server/sse.ts";
import { create } from "@bufbuild/protobuf";
import { uiHandlers } from "@canopy/gateway/api";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { startTestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("thread failures stay scoped over real gRPC", () => {
  let gateway: Awaited<ReturnType<typeof startTestGateway>>;
  let thread: string;
  beforeAll(async () => {
    gateway = await startTestGateway();
    const project = (await gateway.api.createProject({ name: "Watch failures" })).project!.id;

    const workspace = (
      await gateway.api.createWorkspace({ projectId: project, workerId: gateway.workerId, rootPath: "/repo/failures" })
    ).workspace!.id;

    thread = (
      await gateway.api.createThread({
        projectId: project,
        workspaceId: workspace,
        provider: Provider.CODEX,
        title: "Saved thread",
        clientRequestId: crypto.randomUUID(),
      })
    ).thread!.id;
  }, 30_000);
  test("mobile suspension cancels without a failure and foreground resumes the saved sequence", async () => {
    const original = (await gateway.api.getThread({ threadId: thread })).thread!;

    const target = (
      await gateway.api.createThread({
        projectId: original.projectId,
        workspaceId: original.workspaceId,
        provider: Provider.CODEX,
      })
    ).thread!.id;

    const server = await startConnectHttpServer({
      routes: (router) => router.service(ui.GatewayService, uiHandlers(gateway.core)),
    });

    const api = mobileClient({ gatewayUrl: server.url, development: true, fetch }).api;
    let state: ui.ThreadSnapshot | undefined;
    let snapshots = 0;
    const failures: number[] = [];

    try {
      for (let phase = 0; phase < 2; phase++) {
        const controller = new AbortController();
        await runStream({
          signal: controller.signal,
          recovery: new ConnectionRecovery(10_000),
          start: (signal) =>
            api.watchThread(
              { threadId: target, sequence: true, syncCursor: state?.syncCursor },
              { signal, timeoutMs: 5000 },
            ),
          receive: (update) => {
            state = applyThreadUpdate(state, update);

            if (update.change.case === "snapshot") snapshots++;

            if (update.change.case === "snapshot" || (update.change.case === "batch" && update.change.value.caughtUp))
              controller.abort();
          },
          failed: (error) => {
            failures.push(error.code);

            return false;
          },
          started() {},
          publish() {},
          retryAt: () => 0,
          planned: () => false,
        });

        if (phase === 0) await gateway.api.updateThread({ threadId: target, title: "Changed while suspended" });
      }

      expect(failures).toEqual([]);
      expect(snapshots).toBe(1);
      expect(state!.thread?.title).toBe("Changed while suspended");
    } finally {
      await server.close();
    }
  });
  test("mobile treats a clean premature stream end as a bounded watch failure", async () => {
    const repair = new ThreadWatchRecovery();
    const connection = new ConnectionRecovery(10_000);
    const actions: string[] = [];

    const server = await startConnectHttpServer({
      routes: (router) =>
        router.service(ui.GatewayService, {
          async *watchThread() {
            yield create(ui.ThreadUpdateSchema, {
              change: {
                case: "snapshot",
                value: {
                  syncCursor: { threadId: thread, epoch: "eof-test", appliedSeq: BigInt(actions.length + 1) },
                },
              },
            });
          },
        }),
    });

    const api = mobileClient({ gatewayUrl: server.url, development: true, fetch }).api;

    try {
      await runStream({
        signal: AbortSignal.timeout(8000),
        recovery: connection,
        start: (signal) => api.watchThread({ threadId: thread, sequence: true }, { signal }),
        receive: (update) => {
          const state = applyThreadUpdate(undefined, update);
          repair.advanced(state.syncCursor!.appliedSeq);
          connection.succeeded();
        },
        failed: (error) => {
          expect(error.code).toBe(Code.Unavailable);
          expect(error.metadata.get("canopy-stream-ended")).toBe("true");
          const decision = repair.failed({ code: error.code });
          actions.push(decision.action);

          return decision.action !== "stop";
        },
        started() {},
        publish() {},
        retryAt: () => 0,
        planned: () => false,
      });
      expect(actions).toEqual(["resume", "resume", "stop"]);
    } finally {
      await server.close();
    }
  }, 10000);
  test.each(["grpc", "mobile"])(
    "%s rejects an oversized frame atomically and resumes a bounded watch",
    async (kind) => {
      let oversized = true;
      const recovery = new ThreadWatchRecovery();
      let state: ui.ThreadSnapshot | undefined;

      const server = await (kind === "grpc" ? startGrpcServer : startConnectHttpServer)({
        routes: (router) =>
          router.service(ui.GatewayService, {
            ...uiHandlers(gateway.core),
            async *watchThread(request, context) {
              if (oversized) {
                yield create(ui.ThreadUpdateSchema, {
                  change: {
                    case: "snapshot",
                    value: {
                      thread: { id: request.threadId },
                      syncCursor: { threadId: request.threadId, epoch: "oversized-test", appliedSeq: 0n },
                    },
                  },
                });
                yield create(ui.ThreadUpdateSchema, {
                  change: {
                    case: "batch",
                    value: {
                      threadId: request.threadId,
                      epoch: "oversized-test",
                      appliedSeq: 1n,
                      headSeq: 1n,
                      caughtUp: true,
                      records: [{ seq: 1n, key: "x".repeat(THREAD_BATCH_BYTES) }],
                    },
                  },
                });

                return;
              }

              yield* gateway.api.watchThread(request, { signal: context.signal });
            },
          }),
      });

      const api =
        kind === "grpc"
          ? createClient(ui.GatewayService, createGrpcTransport({ baseUrl: server.url }))
          : mobileClient({ gatewayUrl: server.url, development: true, fetch }).api;

      try {
        try {
          for await (const update of api.watchThread({ threadId: thread, sequence: true }))
            state = applyThreadUpdate(state, update);
          throw new Error("Oversized batch was accepted");
        } catch (cause) {
          const failure = threadUpdateFailure(cause);
          expect(failure).toMatchObject({ code: 8, reason: "size_limit" });
          expect(failure.frameBytes).toBeGreaterThan(THREAD_BATCH_BYTES);
          expect(state!.syncCursor!.appliedSeq).toBe(0n);
          expect(state!.items).toHaveLength(0);
          expect(recovery.failed(failure).action).toBe("reset");
        }

        oversized = false;
        const abort = new AbortController();

        try {
          for await (const update of api.watchThread({ threadId: thread, sequence: true }, { signal: abort.signal })) {
            state = applyThreadUpdate(undefined, update);
            expect(state.thread?.title).toBe("Saved thread");
            break;
          }
        } finally {
          abort.abort();
        }
      } finally {
        await server.close();
      }
    },
  );
  test.each(["grpc", "mobile"])(
    "%s repairs a dropped batch from its atomic checkpoint without a snapshot",
    async (kind) => {
      const store = new ComputerStore(gateway.runtime, gateway.userId, gateway.secretsKey);
      const original = (await gateway.api.getThread({ threadId: thread })).thread!;

      const target = (
        await gateway.api.createThread({
          projectId: original.projectId,
          workspaceId: original.workspaceId,
          provider: Provider.CODEX,
        })
      ).thread!.id;

      const abort = new AbortController();
      let state: ui.ThreadSnapshot | undefined;

      try {
        for await (const update of gateway.api.watchThread(
          { threadId: target, sequence: true },
          { signal: abort.signal },
        )) {
          state = applyThreadUpdate(state, update);
          break;
        }
      } finally {
        abort.abort();
      }

      const checkpoint = state!.syncCursor!;
      await store.query(
        `INSERT INTO thread_items(thread_id,item_id,type,status,content,first_seq,last_seq)
      SELECT $1::uuid,$2 || n,'agentMessage','completed',
        jsonb_build_object('itemId',$2 || n,'agentMessage',jsonb_build_object('text',repeat('x',2000))),n+10,n+10
      FROM generate_series(1,100) n`,
        [target, `${kind}-gap-`],
      );
      let dropped = false;

      const server = await (kind === "grpc" ? startGrpcServer : startConnectHttpServer)({
        routes: (router) =>
          router.service(ui.GatewayService, {
            ...uiHandlers(gateway.core),
            async *watchThread(request, context) {
              for await (const update of gateway.api.watchThread(request, { signal: context.signal })) {
                if (!dropped && update.change.case === "batch" && update.change.value.records.length) {
                  dropped = true;
                  continue;
                }

                yield update;
              }
            },
          }),
      });

      const api =
        kind === "grpc"
          ? createClient(ui.GatewayService, createGrpcTransport({ baseUrl: server.url }))
          : mobileClient({ gatewayUrl: server.url, development: true, fetch }).api;

      const recovery = new ThreadWatchRecovery();
      const decisions: string[] = [];

      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          const controller = new AbortController();

          try {
            for await (const update of api.watchThread(
              { threadId: target, sequence: true, syncCursor: state!.syncCursor },
              { signal: controller.signal, timeoutMs: 5000 },
            )) {
              expect(update.change.case).not.toBe("snapshot");
              state = applyThreadUpdate(state, update);

              if (update.change.case === "batch" && update.change.value.caughtUp) break;
            }
          } catch (cause) {
            const failure = threadUpdateFailure(cause);
            const decision = recovery.failed(failure);
            decisions.push(decision.action);
            expect(failure.reason).toBe("invalid_range");
            expect(state!.syncCursor!.appliedSeq).toBe(checkpoint.appliedSeq);
          } finally {
            controller.abort();
          }
        }

        expect(decisions).toEqual(["resume"]);
        expect(state!.items.filter((item) => item.item?.itemId.startsWith(`${kind}-gap-`))).toHaveLength(100);
        expect(state!.syncCursor!.appliedSeq).toBeGreaterThan(checkpoint.appliedSeq);
      } finally {
        await server.close();
      }
    },
  );

  test("progress followed by repeated drops stops retrying and retains increasing backoff", async () => {
    const recovery = new ThreadWatchRecovery();

    for (let attempt = 0; attempt < 5; attempt++) {
      expect(recovery.failed({ code: 14, computer: true }).action).toBe("resume");
    }

    const connection = new ConnectionRecovery(10_000);
    const actions: string[] = [];
    const delays: number[] = [];

    const server = await startGrpcServer({
      routes: (router) =>
        router.service(ui.GatewayService, {
          async *watchThread(request) {
            yield create(ui.ThreadUpdateSchema, {
              change: {
                case: "snapshot",
                value: {
                  thread: { id: request.threadId },
                  syncCursor: {
                    threadId: request.threadId,
                    epoch: crypto.randomUUID(),
                    appliedSeq: BigInt(actions.length + 1),
                  },
                },
              },
            });
            throw new ConnectError("Injected dropped stream", Code.Unavailable);
          },
        }),
    });

    const api = createClient(ui.GatewayService, createGrpcTransport({ baseUrl: server.url }));

    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        const now = attempt * 5000;
        connection.begin(now);

        try {
          for await (const update of api.watchThread({ threadId: thread })) {
            const state = applyThreadUpdate(undefined, update);
            recovery.advanced(state.syncCursor!.appliedSeq, now);
            connection.succeeded(now);
          }
        } catch (cause) {
          const decision = recovery.failed({ code: ConnectError.from(cause).code });
          actions.push(decision.action);
          delays.push(connection.failed(now + 1, 1).retryAt! - now - 1);

          if (decision.action === "stop") break;
        }
      }

      expect(actions).toEqual(["resume", "resume", "stop"]);
      expect(delays).toEqual([1000, 2000, 4000]);
      expect(readThreadWatchFailure('{"code":15,"reason":"secret host/path/token","frameBytes":-1}')).toMatchObject({
        code: 15,
        reason: undefined,
        frameBytes: 0,
      });
    } finally {
      await server.close();
    }
  });
  test("web SSE preserves the fixed thread reason and size without exposing exception text", async () => {
    const server = await startGrpcServer({
      routes: (router) =>
        router.service(ui.GatewayService, {
          async *watchThread() {
            yield await Promise.reject(
              new ConnectError("private host and transcript", Code.ResourceExhausted, {
                "canopy-error-scope": "thread",
                "canopy-sync-reason": "size_limit",
                "canopy-frame-bytes": "70000",
              }),
            );
          },
        }),
    });

    const api = createClient(ui.GatewayService, createGrpcTransport({ baseUrl: server.url }));

    try {
      const response = sseResponse(
        new Request("http://localhost/events"),
        (signal) => api.watchThread({ threadId: thread, sequence: true }, { signal }),
        () => null,
      );

      const text = await response.text();
      expect(text).toContain("event: failure");
      expect(text).toContain('"reason":"size_limit"');
      expect(text).toContain('"code":8');
      expect(text).toContain('"frameBytes":70000');
      expect(text).not.toContain("private host and transcript");
    } finally {
      await server.close();
    }
  });
  afterAll(async () => {
    await gateway?.close();
  });

  test.each([Code.ResourceExhausted, Code.DataLoss, Code.OutOfRange, Code.Unavailable])(
    "watch code %s stops after bounded repairs while unary remains healthy",
    async (code) => {
      let attempts = 0;

      const server = await startGrpcServer({
        routes: (router) =>
          router.service(ui.GatewayService, {
            ...uiHandlers(gateway.core),
            async *watchThread() {
              attempts++;
              yield await Promise.reject(new ConnectError("Injected watch failure", code));
            },
          }),
      });

      const api = createClient(ui.GatewayService, createGrpcTransport({ baseUrl: server.url }));
      const recovery = new ThreadWatchRecovery();
      const decisions: string[] = [];

      try {
        for (let i = 0; i < 6; i++) {
          expect((await api.getThread({ threadId: thread })).thread?.title).toBe("Saved thread");

          try {
            for await (const _ of api.watchThread({ threadId: thread, sequence: true })) {
              /* injected before first frame */
            }
          } catch (error) {
            const decision = recovery.failed({ code: ConnectError.from(error).code });
            decisions.push(decision.action);

            if (decision.action === "stop") break;
          }
        }

        expect(attempts).toBe(3);
        expect(decisions).toEqual(
          code === Code.Unavailable ? ["resume", "resume", "stop"] : ["reset", "smaller", "stop"],
        );
      } finally {
        await server.close();
      }
    },
  );
  test("unknown and malformed stored items preserve the readable window", async () => {
    const store = new ComputerStore(gateway.runtime, gateway.userId, gateway.secretsKey);
    await store.query(
      `INSERT INTO thread_items(thread_id,item_id,type,status,content,first_seq,last_seq) VALUES
      ($1::uuid,'unknown','future','completed',$2::jsonb,1,1),
      ($1::uuid,'malformed','agentMessage','completed',$3::jsonb,2,2)`,
      [
        thread,
        JSON.stringify({ itemId: "unknown", futureItem: { introduced: true } }),
        JSON.stringify({ itemId: "malformed", agentMessage: { text: { invalid: true } } }),
      ],
    );
    const abort = new AbortController();

    try {
      for await (const update of gateway.api.watchThread(
        { threadId: thread, sequence: true },
        { signal: abort.signal },
      )) {
        const snapshot = applyThreadUpdate(undefined, update);
        expect(snapshot.items.length).toBe(2);
        expect(snapshot.items.every((item) => item.item?.itemId)).toBe(true);
        expect(snapshot.thread?.title).toBe("Saved thread");
        break;
      }
    } finally {
      abort.abort();
    }
  });
});
