import { create } from "@bufbuild/protobuf";
import { AgentToolResultSchema, type AgentToolCall, type AgentToolResult, type Welcome } from "@canopy/contracts";

/**
 * Bus tools an older gateway can't execute. The worker answers them itself with what to do, instead of relaying
 * the gateway's "unknown tool" (docs/agent-visuals.md).
 */
export function gatewayToolRefusal(call: AgentToolCall, welcome: Welcome | undefined): AgentToolResult | undefined {
  if (call.toolName !== "render_visual" || !welcome || welcome.threadVisualsV1) return undefined;

  return create(AgentToolResultSchema, {
    callId: call.callId,
    isError: true,
    content: "Update Canopy on the gateway computer to show visuals.",
  });
}
