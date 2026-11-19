import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayCore } from "@canopy/gateway/core";
import { applyThreadUpdate } from "@canopy/domain/thread-snapshot";
import { ClaudeEventMapper } from "../../apps/worker/src/providers/claude/mapping.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("main-session context observations through WorkerLink", () => {
  let gateway: TestGateway;
  let threadId: string;
  let projectId: string;

  beforeAll(async () => {
    gateway = await startTestGateway({ watchProbeMs: 100, worker: { claude: true } });
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

  test("a resumed Claude turn keeps both context counts available for the Text indicator", async () => {
    const original = (await gateway.api.getThread({ threadId })).thread!;

    const id = (
      await gateway.api.createThread({ projectId, workspaceId: original.workspaceId, provider: Provider.CLAUDE })
    ).thread!.id;

    const { api, worker } = gateway;
    await eventually(
      () => api.getThread({ threadId: id }),
      (reply) => reply.thread?.status === "idle",
    );

    const replay = (fixture: string) =>
      readFileSync(new URL(`../../apps/worker/src/providers/claude/fixtures/${fixture}.jsonl`, import.meta.url), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Parameters<ClaudeEventMapper["map"]>[0]);

    let state: ui.ThreadSnapshot | undefined;
    const abort = new AbortController();

    const watching = (async () => {
      try {
        for await (const update of api.watchThread({ threadId: id, sequence: true }, { signal: abort.signal }))
          state = applyThreadUpdate(state, update);
      } catch (error) {
        if (!abort.signal.aborted) throw error;
      }
    })();

    worker.holdTurns = true;

    try {
      const start = async () => {
        const turn = (await api.sendMessage({ threadId: id, text: "Continue" })).turn!;
        await eventually(
          async () => state,
          (snapshot) => snapshot?.thread?.status === "running",
        );

        return turn.id;
      };

      const apply = (mapper: ClaudeEventMapper, messages: ReturnType<typeof replay>) => {
        for (const message of messages)
          for (const event of mapper.map(message)) worker.emit(id, event.turnId ?? "", event.body, event.rawJson);
      };

      const idle = () =>
        eventually(
          async () => state,
          (snapshot) => snapshot?.thread?.status === "idle",
        );

      await idle();
      const first = await start();
      apply(new ClaudeEventMapper(first), replay("text-turn"));
      const previous = (await idle())?.thread?.contextUsage;
      expect(previous).toMatchObject({ usedTokens: 16011n, limitTokens: 1000000n });

      const resumed = await start();
      const mapper = new ClaudeEventMapper(resumed, true);
      const next = replay("tools-turn");
      const result = next.findIndex((message) => message.type === "result");
      expect(result).toBeGreaterThan(0);
      apply(mapper, next.slice(0, result));

      // The final streamed answer is projected before result, so all earlier usage has arrived.
      const active = await eventually(
        async () => state,
        (snapshot) =>
          snapshot?.thread?.status === "running" &&
          snapshot.items.some(
            (entry) =>
              entry.turnId === resumed &&
              entry.item?.content.case === "agentMessage" &&
              entry.item.content.value.phase === "final_answer",
          ),
      );

      expect(active?.thread?.contextUsage).toEqual(previous);

      apply(mapper, next.slice(result));
      expect((await idle())?.thread?.contextUsage).toMatchObject({ usedTokens: 16891n, limitTokens: 1000000n });
    } finally {
      worker.holdTurns = false;
      abort.abort();
      await watching;
    }
  }, 30_000);
});
