import type { GatewayCore } from "../core/core.ts";
import { guard } from "./ui-errors.ts";
import type { UiHandlers } from "./ui-service.ts";

export function agentToolsHandlers(
  core: GatewayCore,
): Pick<UiHandlers, "installAgentTool" | "refreshAgentTools" | "runAgentTool" | "setAgentToolEnabled"> {
  return {
    installAgentTool: (request) => guard(() => core.installAgentTool(request)),
    refreshAgentTools: (request) => guard(() => core.refreshAgentTools(request)),
    runAgentTool: (request) => guard(() => core.runAgentTool(request)),
    setAgentToolEnabled: (request) => guard(() => core.setAgentToolEnabled(request)),
  };
}
