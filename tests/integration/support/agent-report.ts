import { ItemStatus, TurnOutcome } from "@canopy/contracts";
import { ProviderFailure } from "@canopy/domain";
import { expect } from "bun:test";
import { eventually, type ScriptedWorker, type TestGateway } from "./gateway.ts";

/** A provider may publish commentary and then end the turn without a final answer. */
export function failAfterCommentary(
  worker: ScriptedWorker,
  thread: string,
  turn: string,
  reason: string,
  ...messages: string[]
) {
  for (const [index, text] of messages.entries())
    worker.emit(thread, turn, {
      case: "itemCompleted",
      value: {
        item: {
          itemId: `message-${index}-${turn}`,
          status: ItemStatus.COMPLETED,
          content: { case: "agentMessage", value: { text, phase: text ? "commentary" : "final_answer" } },
        },
      },
    });
  worker.emit(thread, turn, { case: "turnFinished", value: { outcome: TurnOutcome.FAILED, reason } });
}

export async function disconnectedBotModel(): Promise<never> {
  throw new ProviderFailure("network", "Upstream closed the stream");
}

export async function expectLinkedBotFailure(home: TestGateway, threadId: string, bot: string) {
  const sent = await home.worker.callTool({
    threadId,
    tool: "send_message",
    args: { target_kind: "bot", thread_id: bot, prompt: "check the stream" },
  });

  expect(sent.isError).toBe(false);

  const report = await eventually(
    async () =>
      (await home.core.linkedAgents.snapshot(threadId)).turns.find(
        (t) => t.sourceKind === "report" && t.sourceStatus === "failed",
      ),
    Boolean,
  );

  expect(report?.messageText).toBe("Turn failed: Upstream closed the stream");
}
