import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createClient, Code, ConnectError } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { ThreadWatchRecovery } from "@canopy/domain/thread-watch-recovery";
import { applyThreadUpdate } from "@canopy/domain/thread-snapshot";
import { startGrpcServer } from "@canopy/transport";
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
