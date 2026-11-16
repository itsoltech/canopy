import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayCore } from "@canopy/gateway/core";
import { applyThreadUpdate } from "@canopy/domain/thread-snapshot";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("main-session context observations through WorkerLink", () => {
  let gateway: TestGateway;
  let threadId: string;
  let projectId: string;

  beforeAll(async () => {
    gateway = await startTestGateway({ watchProbeMs: 100 });
    projectId = (await gateway.api.createProject({ name: "Context observations" })).project!.id;

    const workspaceId = (
      await gateway.api.createWorkspace({
        projectId,
        workerId: gateway.workerId,
        rootPath: "/repo/context",
      })
    ).workspace!.id;

    threadId = (
      await gateway.api.createThread({
        projectId,
        workspaceId,
        provider: Provider.CODEX,
        title: "Context",
      })
    ).thread!.id;
    await eventually(
      () => gateway.api.getThread({ threadId }),
      (reply) => reply.thread?.status === "idle",
    );
  }, 30000);

  afterAll(async () => {
    await gateway?.close();
  });

  test("live checkpoints and fresh reads share the latest observation without summing accounting", async () => {
    expect((await gateway.api.getThread({ threadId })).thread?.contextUsage).toBeUndefined();
    let state: ui.ThreadSnapshot | undefined;
    const abort = new AbortController();

    const watching = (async () => {
      try {
        for await (const update of gateway.api.watchThread({ threadId, sequence: true }, { signal: abort.signal }))
          state = applyThreadUpdate(state, update);
      } catch (error) {
        if (!abort.signal.aborted) throw error;
      }
    })();

    try {
      await eventually(
        async () => state,
        (snapshot) => Boolean(snapshot?.thread),
      );
      gateway.worker.emit(threadId, "", {
        case: "usageUpdated",
        value: { usage: { inputTokens: 9000000n }, contextUsage: { usedTokens: 18000n, limitTokens: 258400n } },
      });
      await eventually(
        async () => state,
        (snapshot) => snapshot?.thread?.contextUsage?.usedTokens === 18000n,
      );
      const fresh = new GatewayCore({ runtime: gateway.runtime, instanceId: "context-reader", userId: gateway.userId });
      expect((await fresh.getThread(threadId)).contextUsage).toMatchObject({
        usedTokens: 18000n,
        limitTokens: 258400n,
      });
      const listed = (await gateway.api.listThreads({ projectId })).threads.find((thread) => thread.id === threadId);
      expect(listed?.contextUsage).toMatchObject({ usedTokens: 18000n, limitTokens: 258400n });

      // A legacy worker's accounting-only event cannot masquerade as a context observation.
      gateway.worker.emit(threadId, "", { case: "usageUpdated", value: { usage: { inputTokens: 9900000n } } });
      gateway.worker.emit(threadId, "", {
        case: "usageUpdated",
        value: { contextUsage: { usedTokens: 1000n, limitTokens: 258400n } },
      });
      await eventually(
        async () => state,
        (snapshot) => snapshot?.thread?.contextUsage?.usedTokens === 1000n,
      );
      expect((await fresh.getThread(threadId)).contextUsage?.usedTokens).toBe(1000n);

      // Unknown limits replace previous limits, and a measured zero stays distinct from unknown.
      gateway.worker.emit(threadId, "", { case: "usageUpdated", value: { contextUsage: { usedTokens: 0n } } });
      await eventually(
        async () => state,
        (snapshot) => snapshot?.thread?.contextUsage?.usedTokens === 0n,
      );
      expect((await fresh.getThread(threadId)).contextUsage?.limitTokens).toBeUndefined();

      gateway.worker.emit(threadId, "", { case: "usageUpdated", value: { contextUsage: {} } });
      await eventually(
        async () => state,
        (snapshot) => snapshot?.thread?.contextUsage?.usedTokens === undefined,
      );
      expect((await fresh.getThread(threadId)).contextUsage?.usedTokens).toBeUndefined();
      expect((await fresh.getThread(threadId)).contextUsage?.limitTokens).toBeUndefined();
    } finally {
      abort.abort();
      await watching;
    }
  });
});
