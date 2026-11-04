import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { type GatewayCore } from "../core/core.ts";
import { guard } from "./ui-errors.ts";
import type { UiHandlers } from "./ui-service.ts";

export function queueHandlers(
  core: GatewayCore,
): Pick<
  UiHandlers,
  "reorderQueuedTurns" | "editQueuedTurn" | "deleteQueuedTurn" | "restoreQueuedTurn" | "steerQueuedTurn"
> {
  return {
    reorderQueuedTurns: (request) =>
      guard(async () => create(ui.ReorderQueuedTurnsResponseSchema, { turns: await core.reorderQueuedTurns(request) })),

    editQueuedTurn: (request) =>
      guard(async () => create(ui.EditQueuedTurnResponseSchema, { turn: await core.editQueuedTurn(request) })),

    deleteQueuedTurn: (request) =>
      guard(async () =>
        create(ui.DeleteQueuedTurnResponseSchema, { turn: await core.deleteQueuedTurn(request.turnId) }),
      ),

    restoreQueuedTurn: (request) =>
      guard(async () =>
        create(ui.RestoreQueuedTurnResponseSchema, { turn: await core.restoreQueuedTurn(request.turnId) }),
      ),

    steerQueuedTurn: (request) =>
      guard(async () => create(ui.SteerQueuedTurnResponseSchema, await core.steerQueuedTurn(request.turnId))),
  };
}
