/**
 * Read state of threads (Thread.unseen_result, MarkThreadSeen): a finished turn the user has not seen marks the
 * thread with its result in GetThread, ListThreads and the live overview, until the thread page reports it seen.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@connectrpc/connect";
import { InteractionKind, PermissionMode, Provider, TurnOrigin, TurnOutcome, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

let gw: TestGateway;
let api: Client<typeof ui.GatewayService>;

describe.skipIf(!dockerAvailable)("thread read state (gateway)", () => {
  let projectId = "";
  let workspaceId = "";

  beforeAll(async () => {
    gw = await startTestGateway();
    api = gw.api;
    projectId = (await api.createProject({ name: "Reads" })).project!.id;
    workspaceId = (await api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo/reads" })).workspace!
      .id;
    await eventually(
      () => api.getOverview({}),
      (o) => o.workers.every((w) => w.appliedVersion === 1n),
    );
  }, 60_000);

  afterAll(async () => {
    await gw?.close();
  });

  /** One turn the scripted worker finishes with `outcome`. */
  const runTurn = async (threadId: string, outcome: TurnOutcome, request: string) => {
    gw.worker.handlers.set("startTurn", (value, reply) => {
      const turnId = (value as { turnId: string }).turnId;
      reply(true);
      gw.worker.emit(threadId, turnId, { case: "turnStarted", value: { origin: TurnOrigin.COMMAND } });
      gw.worker.emit(threadId, turnId, { case: "turnFinished", value: { outcome } });
    });
    await api.sendMessage({ threadId, text: "go", clientRequestId: request });
    await eventually(
      () => api.getThread({ threadId }),
      (r) => r.thread?.status !== "running" && r.thread?.unseenResult !== "",
    );
    gw.worker.handlers.delete("startTurn");
  };

  test("a finished turn stays unseen until marked, live on the overview; the marker only grows", async () => {
    const thread = (
      await api.createThread({
        projectId,
        workspaceId,
        title: "r",
        provider: Provider.CODEX,
        permissionMode: PermissionMode.ASK,
      })
    ).thread!;

    const threadId = thread.id;
    await eventually(
      () => api.getThread({ threadId }),
      (r) => r.thread?.status === "idle",
    );
    expect((await api.getThread({ threadId })).thread?.unseenResult).toBe("");

    const seen: ui.Thread[] = [];
    const controller = new AbortController();

    const watching = (async () => {
      for await (const u of api.watchOverview({}, { signal: controller.signal }))
        if (u.change.case === "thread" && u.change.value.id === threadId) seen.push(u.change.value);
    })().catch(() => {});

    await Bun.sleep(50);

    await runTurn(threadId, TurnOutcome.COMPLETED, "read-1");
    const finished = (await api.getThread({ threadId })).thread!;
    expect(finished.unseenResult).toBe("completed");
    expect((await api.listThreads({})).threads.find((t) => t.id === threadId)?.unseenResult).toBe("completed");
    await eventually(
      async () => seen.at(-1),
      (t) => t?.unseenResult === "completed",
    );

    // Seen up to an earlier event: still unseen; up to the last one (or beyond, capped): cleared, live.
    expect((await api.markThreadSeen({ threadId, upToSeq: 1n })).thread?.unseenResult).toBe("completed");
    const cleared = await api.markThreadSeen({ threadId, upToSeq: finished.lastSeq + 100n });
    expect(cleared.thread?.unseenResult).toBe("");
    await eventually(
      async () => seen.at(-1),
      (t) => t?.unseenResult === "",
    );
    // A lower marker later (another device behind) does not bring it back.
    expect((await api.markThreadSeen({ threadId, upToSeq: 1n })).thread?.unseenResult).toBe("");

    // The next turn fails: its result is what the user has not seen.
    await runTurn(threadId, TurnOutcome.FAILED, "read-2");
    expect((await api.getThread({ threadId })).thread?.unseenResult).toBe("failed");
    const last = (await api.getThread({ threadId })).thread!.lastSeq;
    expect((await api.markThreadSeen({ threadId, upToSeq: last })).thread?.unseenResult).toBe("");

    controller.abort();
    await watching;
  }, 30_000);

  test("notification previews: the waiting question, then the plain, redacted answer until seen", async () => {
    const threadId = (
      await api.createThread({
        projectId,
        workspaceId,
        title: "n",
        provider: Provider.CODEX,
        permissionMode: PermissionMode.ASK,
      })
    ).thread!.id;

    await eventually(
      () => api.getThread({ threadId }),
      (r) => r.thread?.status === "idle",
    );
    gw.worker.holdTurns = true;
    const before = gw.worker.started.size;
    await api.sendMessage({ threadId, text: "go", clientRequestId: "notice-1" });

    const turnId = (
      await eventually(
        async () => [...gw.worker.started.keys()],
        (ids) => ids.length > before,
      )
    ).at(-1)!;

    const requestId = Bun.randomUUIDv7();
    gw.worker.link.send({
      case: "interactionRequest",
      value: {
        requestId,
        threadId,
        turnId,
        kind: InteractionKind.QUESTION,
        toolName: "request_user_input",
        requestJson: JSON.stringify({ questions: [{ id: "q", question: "Deploy to `staging` first?", options: [] }] }),
      },
    });

    const asking = (
      await eventually(
        () => api.getThread({ threadId }),
        (r) => (r.thread?.pendingInteractions ?? 0) > 0,
      )
    ).thread!;

    expect(asking).toMatchObject({ noticePreview: "Deploy to staging first?", noticeInteractionKind: "question" });

    await api.answerInteraction({ requestId, answerJson: JSON.stringify({ q: { answers: ["Yes"] } }) });
    gw.worker.finish(
      threadId,
      turnId,
      "## Done\n\nAll **green**. Token: sk-live1234567890 and api_key=hunter2, see [the log](https://ci.example/run?token=abc).\n\n```sh\nexport SECRET=x\n```",
    );
    gw.worker.holdTurns = false;

    const done = (
      await eventually(
        () => api.getThread({ threadId }),
        (r) => r.thread?.unseenResult === "completed" && r.thread.pendingInteractions === 0,
      )
    ).thread!;

    expect(done.noticePreview).toBe("Done. All green. Token: [redacted] and api_key=[redacted], see the log.");
    expect(done.interruptedByUser).toBe(false);
    const seen = await api.markThreadSeen({ threadId, upToSeq: done.lastSeq });
    expect(seen.thread).toMatchObject({ unseenResult: "", noticePreview: "" });
  }, 30_000);

  test("unknown threads are refused", async () => {
    expect(await failure(api.markThreadSeen({ threadId: Bun.randomUUIDv7(), upToSeq: 1n }))).toContain("not");
  });
});
