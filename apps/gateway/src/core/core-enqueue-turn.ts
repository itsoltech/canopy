import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import type { TurnStore } from "../store/turns-store.ts";
import { toUiTurn } from "../store/index.ts";
import { coreState } from "./core-context.ts";
import type { GatewayCore } from "./core.ts";
import { coreRun } from "./core-broadcast.ts";
import { corePumpQueued } from "./core-work-loop.ts";

/** An idle message and its StartTurn become visible together, including to reconnecting clients. */
export async function coreEnqueueTurn(
  hostContext: GatewayCore,
  input: Parameters<TurnStore["enqueueTurn"]>[0],
): Promise<ui.Turn> {
  hostContext[coreState].pumpAdmissions++;

  try {
    return await hostContext[coreState].actions.transaction(async () => {
      const turn = await coreRun(hostContext, (s) => s.enqueueTurn(input));

      if (!hostContext.updates.draining) await corePumpQueued(hostContext, input.threadId);

      const current = (await coreRun(hostContext, (s) => s.turnsOf(input.threadId))).find((t) => t.id === turn.id)!;
      const update = toUiTurn(current);
      hostContext.hub.publishThread(
        input.threadId,
        create(ui.ThreadUpdateSchema, { change: { case: "turn", value: update } }),
      );

      return update;
    });
  } finally {
    hostContext[coreState].pumpAdmissions--;
  }
}
