import { create } from "@bufbuild/protobuf";
import { AgentToolResultSchema, type AgentToolCall, type AgentToolResult, type Welcome } from "@canopy/contracts";

/**
 * Bus tools an older gateway can't execute. The worker answers them itself with what to do, instead of relaying
 * the gateway's "unknown tool" (docs/agent-visuals.md).
 */
export function gatewayToolRefusal(call: AgentToolCall, welcome: Welcome | undefined): AgentToolResult | undefined {
  if (!welcome) return undefined;

  const video = call.toolName === "show_video" && !call.connectorAccountId && !call.botId;

  const unavailable =
    (call.toolName === "render_visual" && !welcome.threadVisualsV1) ||
    (call.toolName === "render_html" && !welcome.threadHtmlV1) ||
    (video && !welcome.threadVideoRepliesV1);

  if (!unavailable) return undefined;

  return create(AgentToolResultSchema, {
    callId: call.callId,
    isError: true,
    content: video
      ? "Update Canopy on the gateway computer to show videos."
      : "Update Canopy on the gateway computer to show visuals.",
  });
}
