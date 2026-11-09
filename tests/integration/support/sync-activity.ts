import { ItemDeltaField, ItemStatus } from "@canopy/contracts";
import type { TestGateway } from "./gateway.ts";
import { eventually } from "./gateway.ts";

/** A thirty-second turn with token deltas, tool results and background command progress. */
export async function syncActivity(gateway: TestGateway, thread: string) {
  gateway.worker.holdTurns = true;

  const turn = (
    await gateway.api.sendMessage({
      threadId: thread,
      text: "Stream realistic work",
      clientRequestId: crypto.randomUUID(),
    })
  ).turn!.id;

  await eventually(async () => gateway.worker.started.has(turn), Boolean);
  gateway.worker.emit(thread, turn, {
    case: "itemStarted",
    value: {
      item: {
        itemId: "answer",
        status: ItemStatus.IN_PROGRESS,
        content: { case: "agentMessage", value: { text: "" } },
      },
    },
  });
  gateway.worker.emit(thread, turn, {
    case: "itemStarted",
    value: {
      item: {
        itemId: "background",
        status: ItemStatus.IN_PROGRESS,
        content: {
          case: "backgroundTask",
          value: { taskId: "scenario-task", description: "Background build", command: "bun build" },
        },
      },
    },
  });

  for (let i = 0; i < 1500; i++) {
    gateway.worker.emit(thread, turn, {
      case: "itemDelta",
      value: { itemId: "answer", field: ItemDeltaField.TEXT, chunk: i % 20 === 19 ? "token\n" : "token " },
    });

    if (i % 50 === 0) {
      gateway.worker.emit(thread, turn, {
        case: "itemCompleted",
        value: {
          item: {
            itemId: `tool-${i}`,
            status: ItemStatus.COMPLETED,
            content: { case: "commandExecution", value: { command: "git status", output: "clean", exitCode: 0 } },
          },
        },
      });
      gateway.worker.emit(thread, turn, {
        case: "itemDelta",
        value: { itemId: "background", field: ItemDeltaField.OUTPUT, chunk: "Build progress\n" },
      });
    }

    await Bun.sleep(20);
  }

  gateway.worker.emit(thread, turn, {
    case: "itemCompleted",
    value: {
      item: {
        itemId: "background",
        status: ItemStatus.COMPLETED,
        content: {
          case: "backgroundTask",
          value: {
            taskId: "scenario-task",
            description: "Background build",
            output: "Build complete",
            command: "bun build",
          },
        },
      },
    },
  });
  gateway.worker.finish(thread, turn);
}
