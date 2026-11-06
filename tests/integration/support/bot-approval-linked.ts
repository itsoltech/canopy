import { expect, spyOn } from "bun:test";
import { bots, InteractionKind, PermissionMode } from "@canopy/contracts";
import { qualifyId } from "@canopy/domain/computers";
import { linkedBotThreadApprovals } from "../../../apps/gateway/src/computers/bot-thread-approvals.ts";
import { eventually, type TestGateway } from "./gateway.ts";

/** A stalled linked home must not delay an ordinary, local owner decision. */
export async function answerWithoutWaitingForPeer(a: TestGateway, card: bots.BotApproval) {
  const linked = Promise.withResolvers<"linked">();
  const release = Promise.withResolvers<void>();

  const slow = async () => {
    linked.resolve("linked");
    await release.promise;
    throw new Error("Slow linked home");
  };

  const snapshot = spyOn(a.core.linkedAgents, "snapshot").mockImplementation(slow);
  const ui = spyOn(a.core.linkedAgents, "ui").mockImplementation(slow);
  const answer = a.api.answerBotApproval({ approvalId: card.id, approve: true, ruleOptionId: card.ruleOptions[0]!.id });

  try {
    expect(await Promise.race([answer.then(() => "answered"), linked.promise])).toBe("answered");
  } finally {
    snapshot.mockRestore();
    ui.mockRestore();
    release.resolve();
    await answer.catch(() => undefined);
  }
}

export async function checkLinkedBotApproval(
  a: TestGateway,
  b: TestGateway,
  botId: string,
  project: string,
  bNode: string,
) {
  b.worker.holdTurns = true;

  try {
    const before = b.worker.created.length;
    await a.api.sendBotMessage({ botId, text: "spawn on B", clientRequestId: crypto.randomUUID() });
    await eventually(
      async () => b.worker.created.length,
      (n) => n > before,
    );
    expect(b.worker.created.length).toBe(before + 1);
    const state = await a.core.bots.run((s) => s.conversation(a.userId, botId));
    expect(state.approvals.some((c) => c.allowedByRule)).toBe(true);
    const child = b.worker.created.at(-1)!.threadId;
    expect((await b.api.getThread({ threadId: child })).thread?.permissionMode).toBe(PermissionMode.ASK);

    const turns = await b.core.linkedAgents.query<{ id: string }>("SELECT id FROM turns WHERE thread_id=$1::uuid", [
      child,
    ]);

    const requestId = crypto.randomUUID();
    b.worker.ask({
      requestId,
      threadId: child,
      turnId: turns[0]!.id,
      kind: InteractionKind.PERMISSION,
      toolName: "shell",
      requestJson: '{"command":"pwd"}',
    });

    const cards = await eventually(
      () => linkedBotThreadApprovals(a.core.linkedAgents, botId),
      (c) => c.some((r) => r.requestId === qualifyId(requestId, bNode)),
    );

    expect(cards.find((c) => c.requestId === qualifyId(requestId, bNode))?.id).toBe(qualifyId(requestId, bNode));
    const request = { threadId: child };
    expect((await b.api.listThreadApprovals(request)).approvals.map((c) => c.id)).toEqual([requestId]);

    const foreign = await b.core.bots.run((s) =>
      s.pendingThreadApprovals(a.userId, {
        $typeName: "canopy.ui.v1.ListThreadApprovalsRequest",
        ...request,
        otherThreadIds: [],
      }),
    );

    expect(foreign).toHaveLength(0);
    await a.api.archiveBot({ botId });

    // Let the one-second UI cache expire without adding another sleep to the test.
    const hidden = await eventually(
      () => linkedBotThreadApprovals(a.core.linkedAgents, botId),
      (c) => c.length === 0,
    );

    expect(hidden).toHaveLength(0);
    await a.api.unarchiveBot({ botId });

    const outcomes = await Promise.allSettled([
      a.api.answerBotApproval({ approvalId: qualifyId(requestId, bNode), approve: true }),
      b.api.answerInteraction({ requestId, allow: false }),
    ]);

    expect(outcomes.some((o) => o.status === "fulfilled")).toBe(true);
    await eventually(
      async () => b.worker.interactionAnswers.filter((r) => r.requestId === requestId).length,
      (n) => n === 1,
    );
    expect(b.worker.interactionAnswers.filter((r) => r.requestId === requestId)).toHaveLength(1);
    expect((await b.api.listThreadApprovals(request)).approvals).toHaveLength(0);
    b.worker.finish(child, turns[0]!.id, "Finished");

    const finished = await eventually(
      () => b.core.linkedAgents.query<{ status: string }>("SELECT status FROM turns WHERE id=$1::uuid", [turns[0]!.id]),
      (rows) => rows[0]?.status === "completed",
    );

    expect(finished[0]?.status).toBe("completed");
    // Even a stale pending row from a finished turn must not be fetched by the chat.
    await b.core.linkedAgents.query(
      "UPDATE interaction_requests SET status='pending', answered_at=NULL WHERE id=$1::uuid",
      [requestId],
    );
    expect((await b.api.listThreadApprovals(request)).approvals).toHaveLength(0);
    await b.core.linkedAgents.query(
      "UPDATE interaction_requests SET status='expired', answered_at=now() WHERE id=$1::uuid",
      [requestId],
    );
  } finally {
    b.worker.holdTurns = false;
  }
}
