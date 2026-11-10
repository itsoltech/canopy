import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ServerNotification } from "@canopy/codex-protocol";
import { BackgroundTaskKind, ItemStatus, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { noticePresentation } from "@canopy/domain/notice-presentation";
import { visibleTurns } from "../../apps/mobile/src/features/threads/thread-turns.ts";
import { FeedBuilder } from "../../apps/web/src/lib/features/threads/feed.ts";
import { CodexEventMapper } from "../../apps/worker/src/providers/codex/mapping.ts";
import {
  commentary,
  completed,
  errorTurn,
  INTERRUPT_ERROR,
} from "../../apps/worker/src/providers/codex/fixtures/provider-errors.ts";
import { eventually, startTestGateway, watchUntil, type TestGateway } from "./support/gateway.ts";
import { followThread } from "./support/thread-watch.ts";

/** Exercise the same projection as web/desktop against states streamed over the real gateway↔worker link. */
function feed(state: ui.ThreadSnapshot) {
  return new FeedBuilder().build({
    entries: state.items.flatMap((entry) =>
      entry.item
        ? [
            {
              id: entry.item.itemId,
              item: entry.item,
              turnId: entry.turnId,
              firstSeq: entry.firstSeq,
              inherited: entry.inherited,
              fromThreadId: entry.fromThreadId,
            },
          ]
        : [],
    ),
    turns: state.turns,
    notices: state.notices.flatMap((n) =>
      n.notice ? [{ seq: n.seq, turnId: n.turnId, notice: n.notice, at: n.occurredAt }] : [],
    ),
    results: new Map(),
    steering: [],
    working: state.thread?.status === "running",
    inheritedEntries: [],
    inheritedTurns: [],
    historyOpen: false,
    openWork: new Set(state.turns.map((t) => t.id)),
  });
}

describe.skipIf(!dockerAvailable)("provider errors and background wake-up turns over gRPC", () => {
  let gw: TestGateway;
  let projectId: string;
  let workspaceId: string;

  beforeAll(async () => {
    gw = await startTestGateway();
    gw.worker.holdTurns = true;
    projectId = (await gw.api.createProject({ name: "Provider errors" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo" })).workspace!.id;
  }, 60_000);

  afterAll(async () => {
    await gw?.close();
  });

  async function start() {
    const thread = (
      await gw.api.createThread({
        projectId,
        workspaceId,
        provider: Provider.CODEX,
        title: "Provider error",
        initialMessage: "Keep working",
      })
    ).thread!;

    const abort = new AbortController();
    const live = await followThread(gw.api.watchThread({ threadId: thread.id }, { signal: abort.signal }), abort);
    await live.until((s) => s.turns[0]?.status === "running");
    const turnId = live.state.turns[0]!.id;

    const mapper = new CodexEventMapper({
      startTurn: () => turnId,
      turnId: () => turnId,
      isCommandTurn: () => true,
    });

    const emit = (notification: ServerNotification) => {
      for (const event of mapper.map(notification))
        gw.worker.emit(thread.id, event.turnId ?? "", event.body, event.rawJson);
    };

    return { threadId: thread.id, turnId, live, emit };
  }

  for (const willRetry of [false, true])
    test(`a notice with willRetry=${willRetry} leaves the turn running through more work and completion`, async () => {
      const { threadId, turnId, live, emit } = await start();

      try {
        for (const n of errorTurn(threadId, "provider-turn", willRetry)) emit(n);
        await live.until((s) => s.notices.length === 1 && s.items.length > 0);
        expect(live.state.turns[0]).toMatchObject({ id: turnId, status: "running", error: "" });
        expect(live.state.thread?.status).toBe("running");
        expect(feed(live.state).some((r) => r.kind === "timeline" && r.row.kind === "turn-end")).toBe(false);

        emit(completed(threadId, "provider-turn"));
        await live.until((s) => s.turns[0]?.status === "completed" && s.thread?.status === "idle");
        const updates = await watchUntil(gw.api, threadId, (all) => all.some((u) => u.change.case === "snapshot"));
        const saved = updates[0]!.change;
        expect(saved.case === "snapshot" && saved.value.turns[0]?.status).toBe("completed");
        expect(noticePresentation(live.state.notices[0]!.notice!).message).toBe(
          "Provider error 400: no active upstream websocket for response.interrupt",
        );
      } finally {
        await live.close();
      }
    });

  test("a genuine failure stays before the running background wake-up, including late events and reload", async () => {
    const { threadId, turnId, live, emit } = await start();

    const background = {
      itemId: "bg:deploy",
      status: ItemStatus.IN_PROGRESS,
      content: {
        case: "backgroundTask" as const,
        value: {
          kind: BackgroundTaskKind.PROCESS,
          taskId: "deploy",
          command: "fixture process",
          startedInTurnId: turnId,
        },
      },
    };

    try {
      gw.worker.emit(threadId, turnId, { case: "itemStarted", value: { item: background } });

      for (const n of errorTurn(threadId, "failed", false)) emit(n);
      emit(completed(threadId, "failed", "failed"));
      await live.until((s) => s.turns[0]?.status === "failed" && s.thread?.status === "idle");
      expect(live.state.turns[0]).toMatchObject({
        error: INTERRUPT_ERROR,
        errorSource: "harness",
        errorCode: "httpConnectionFailed:400",
      });
      gw.worker.emit(threadId, "", {
        case: "itemCompleted",
        value: {
          item: {
            ...background,
            status: ItemStatus.INTERRUPTED,
            content: { ...background.content, value: { ...background.content.value, stopReason: "worker_shutdown" } },
          },
        },
      });

      await live.until((s) => s.turns.some((t) => t.trigger === "background_task" && t.status === "running"));
      const wake = live.state.turns.find((t) => t.trigger === "background_task")!;
      // Actual newer work, then an old-turn item and repeated failure arriving out of order.
      gw.worker.emit(threadId, wake.id, {
        case: "itemCompleted",
        value: {
          item: {
            itemId: "wake-work",
            status: ItemStatus.COMPLETED,
            content: { case: "agentMessage", value: { text: "Checking the stopped process", phase: "commentary" } },
          },
        },
      });
      emit(commentary(threadId, "failed", "Late old-turn output"));
      emit(completed(threadId, "failed", "failed"));
      emit({ method: "thread/status/changed", params: { threadId, status: { type: "systemError" } } });
      // Wait for newer work after the activity event, so assertions cannot race its ingest.
      gw.worker.emit(threadId, wake.id, {
        case: "itemCompleted",
        value: {
          item: {
            itemId: "wake-after-activity",
            status: ItemStatus.COMPLETED,
            content: {
              case: "agentMessage",
              value: { text: "Work after the late provider activity", phase: "commentary" },
            },
          },
        },
      });
      await live.until((s) => s.items.some((i) => i.item?.itemId === "wake-after-activity"));

      const check = (state: ui.ThreadSnapshot) => {
        expect(state.turns.map((t) => [t.id, t.status])).toEqual([
          [turnId, "failed"],
          [wake.id, "running"],
        ]);
        expect(state.thread?.status).toBe("running");
        expect(visibleTurns(state).map((t) => t.id)).toEqual([turnId, wake.id]);
        const rows = feed(state);

        const failure = rows.findIndex(
          (r) => r.kind === "timeline" && r.row.kind === "turn-end" && r.row.turn.id === turnId,
        );

        const running = rows.findIndex((r) => r.kind === "work" && r.turn.id === wake.id && r.summary.live);
        expect(failure).toBeGreaterThan(-1);
        expect(running).toBeGreaterThan(failure);
        expect(rows.filter((r) => r.kind === "timeline" && r.row.kind === "turn-end")).toHaveLength(1);
      };

      await eventually(
        () => gw.api.getThread({ threadId }),
        (s) => s.thread?.status === "running",
      );
      check(live.state);
      const updates = await watchUntil(gw.api, threadId, (all) => all.some((u) => u.change.case === "snapshot"));
      const saved = updates[0]!.change;

      if (saved.case !== "snapshot") throw new Error("Expected a snapshot");
      check(saved.value);
      expect(wake.backgroundItemIds).toEqual(["bg:deploy"]);
      expect(wake.platformNote).toContain("worker was shut down for a restart or deploy");
      await gw.core.backgroundTasks.tick();
      expect((await gw.api.getThread({ threadId })).thread?.status).toBe("running");
      gw.worker.finish(threadId, wake.id, "Recovered after the background task stopped");
      await live.until((s) => s.turns.find((t) => t.id === wake.id)?.status === "completed");
    } finally {
      await live.close();
    }
  }, 20_000);
});
