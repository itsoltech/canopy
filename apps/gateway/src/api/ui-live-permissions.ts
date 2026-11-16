import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import type { GatewayCore } from "../core/core.ts";
import { guard } from "./ui-errors.ts";
import type { UiHandlers } from "./ui-service.ts";

export function liveTurnPermissionHandlers(core: GatewayCore): Pick<UiHandlers, "updateTurnPermissions"> {
  return {
    updateTurnPermissions: (request) =>
      guard(async () =>
        create(ui.UpdateTurnPermissionsResponseSchema, { turn: await core.updateTurnPermissions(request) }),
      ),
  };
}
