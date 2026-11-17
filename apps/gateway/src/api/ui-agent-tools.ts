import type { GatewayCore } from "../core/core.ts";
import { guard, toConnectError } from "./ui-errors.ts";
import type { UiHandlers } from "./ui-service.ts";

export function agentToolsHandlers(
  core: GatewayCore,
): Pick<
  UiHandlers,
  | "installAgentTool"
  | "refreshAgentTools"
  | "runAgentTool"
  | "setAgentToolEnabled"
  | "watchAgentPreview"
  | "ackAgentPreview"
  | "sendAgentPreviewInput"
> {
  return {
    installAgentTool: (request) => guard(() => core.installAgentTool(request)),
    refreshAgentTools: (request) => guard(() => core.refreshAgentTools(request)),
    runAgentTool: (request) => guard(() => core.runAgentTool(request)),
    setAgentToolEnabled: (request) => guard(() => core.setAgentToolEnabled(request)),
    watchAgentPreview: async function* (request, context) {
      try {
        yield* core.agentPreviews.watch(request, context.signal);
      } catch (cause) {
        throw toConnectError(cause);
      }
    },
    sendAgentPreviewInput: (request) => guard(() => core.agentPreviews.input(request)),
    ackAgentPreview: (request) => guard(() => core.agentPreviews.acknowledge(request)),
  };
}
