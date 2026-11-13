import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import type { GatewayCore } from "../core/core.ts";
import { coreState } from "../core/core-context.ts";
import { connectorGuard } from "./ui-errors.ts";
import type { UiHandlers } from "./ui-service.ts";

/** Allowlist DTO: no endpoints, headers, errors, auth hints or credentials. */
export async function threadPanel(core: GatewayCore, threadId: string) {
  const thread = await core.getThread(threadId);
  const user = core[coreState].options.userId;
  const connectors = await core.connectors.run((store) => store.threadPanel(user, thread.workerId, threadId));

  return create(ui.ThreadPanelSchema, {
    connectors,
    schedules: await core.listSchedules(create(ui.ListSchedulesRequestSchema, { threadId })),
  });
}

export function threadPanelHandlers(core: GatewayCore): Pick<UiHandlers, "getThreadPanel" | "setThreadConnectorGrant"> {
  return {
    getThreadPanel: (request) => connectorGuard(() => threadPanel(core, request.threadId)),
    setThreadConnectorGrant: (request) =>
      connectorGuard(async () => {
        await core.getThread(request.threadId);
        await core.connectors.run((store) => store.threadGrant(core[coreState].options.userId, request));

        return threadPanel(core, request.threadId);
      }),
  };
}
