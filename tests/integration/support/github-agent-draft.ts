import { ItemStatus, TurnOrigin, TurnOutcome } from "@canopy/contracts";
import type { TestGateway } from "./gateway.ts";

/** Script the provider answer while retaining the real message, journal and watch transports. */
export function draftAnswer(gw: TestGateway, text: string, outcome = TurnOutcome.COMPLETED) {
  const inputs: string[] = [];
  gw.worker.handlers.set("startTurn", (command, reply) => {
    if (command.$typeName !== "canopy.worker.v1.StartTurn" || !command.thread) throw new Error("Expected startTurn");
    const { thread, turnId, input } = command;
    inputs.push(input?.text ?? "");
    reply(true);
    const providerTurnRef = `draft-${turnId}`;
    gw.worker.emit(thread.threadId, turnId, {
      case: "turnStarted",
      value: { origin: TurnOrigin.COMMAND, providerTurnRef },
    });
    gw.worker.emit(thread.threadId, turnId, {
      case: "itemCompleted",
      value: {
        item: {
          itemId: `draft-${turnId}`,
          status: ItemStatus.COMPLETED,
          content: { case: "agentMessage", value: { text, phase: "final_answer" } },
        },
      },
    });
    gw.worker.emit(thread.threadId, turnId, { case: "turnFinished", value: { outcome, providerTurnRef } });
  });

  return inputs;
}
