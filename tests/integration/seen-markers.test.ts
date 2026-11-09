import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Provider, ui } from "@canopy/contracts";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { dockerAvailable } from "@canopy/db/testing";
import { SeenMarkers } from "../../apps/web/src/lib/server/seen-markers.ts";
import { gatewayDeadlines } from "../../apps/web/src/lib/server/gateway-deadlines.ts";
import { eventually, startTestGateway, SERVICE_TOKEN, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("coalesced BFF read markers against a gateway", () => {
  let gateway: TestGateway;
  let thread: string;
  beforeAll(async () => {
    gateway = await startTestGateway();
    const project = (await gateway.api.createProject({ name: "Read markers" })).project!.id;

    const workspace = (
      await gateway.api.createWorkspace({
        projectId: project,
        workerId: gateway.workerId,
        rootPath: "/repo/seen",
      })
    ).workspace!.id;

    thread = (await gateway.api.createThread({ projectId: project, workspaceId: workspace, provider: Provider.CODEX }))
      .thread!.id;
    await gateway.core.linkedAgents.query("UPDATE threads SET last_seq=100 WHERE id=$1::uuid", [thread]);
  });
  afterAll(async () => {
    await gateway?.close();
  });

  test("a slow first RPC collapses 100 requests into the first and highest marker, and failure stays best effort", async () => {
    let release = () => {};

    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const calls: bigint[] = [];

    const markers = new SeenMarkers(async (threadId, upToSeq) => {
      calls.push(upToSeq);

      if (calls.length === 1) await gate;
      await gateway.api.markThreadSeen({ threadId, upToSeq });
    });

    markers.enqueue(thread, 1n);

    for (let n = 1n; n <= 100n; n++) markers.enqueue(thread, n);
    expect(calls).toEqual([1n]);
    release();
    await eventually(
      async () => {
        const rows = await gateway.core.linkedAgents.query<{ seen: string }>(
          "SELECT seen_seq::text AS seen FROM thread_reads WHERE thread_id=$1::uuid AND user_id=$2::uuid",
          [thread, gateway.userId],
        );

        return rows[0]?.seen;
      },
      (value) => value === "100",
    );
    expect(calls).toEqual([1n, 100n]);

    const failed = new SeenMarkers(async () => {
      throw new Error("Unavailable");
    });

    expect(() => failed.enqueue(thread, 100n)).not.toThrow();
  });

  test("BFF method budgets allow a real read beyond the former three-second default", async () => {
    const original = gateway.core.getThread.bind(gateway.core);

    const api = createClient(
      ui.GatewayService,
      gatewayDeadlines(
        createGrpcTransport({
          baseUrl: gateway.grpcUrl,
          defaultTimeoutMs: 3000,
          interceptors: [
            (next) => (request) => {
              request.header.set("authorization", `Bearer ${SERVICE_TOKEN}`);

              return next(request);
            },
          ],
        }),
      ),
    );

    gateway.core.getThread = async (id) => {
      await Bun.sleep(3100);

      return original(id);
    };

    try {
      expect((await api.getThread({ threadId: thread })).thread?.id).toBe(thread);
    } finally {
      gateway.core.getThread = original;
    }
  });
});
