import { create } from "@bufbuild/protobuf";
import { AgentTool, ui, type AgentToolCall } from "@canopy/contracts";
import { isJsonArray, str, type JsonObject, type JsonValue } from "@canopy/domain/json";

/** Bounded identifiers only: never forward a URL, path, option or free-form tool input. */
function selector(value: JsonValue | undefined): string {
  const text = str(value);

  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(text) ? text : "";
}

export function automationActivity(
  request: AgentToolCall,
  workerId: string,
  tool: AgentTool,
  name: string,
  input: JsonObject,
) {
  const session = input["session"];

  if (session != null && session !== "" && session !== request.threadId) return undefined;
  // Browser extraArgs may override --session/--namespace. The preview cannot
  // reproduce arbitrary CLI globals, so it follows only the proven default.
  const extra = input["extraArgs"];

  if (tool === AgentTool.BROWSER && extra != null && (!isJsonArray(extra) || extra.length)) return undefined;

  const activity = create(ui.ThreadAutomationActivitySchema, {
    id: request.callId,
    turnId: request.turnId,
    workerId,
    tool,
  });

  if (tool === AgentTool.DEVICE) {
    // Pinned agent-device MCP uses platform plus udid/serial; `device` is a name,
    // not an ID. Conflicting or inferred selectors must use the session default.
    const platform = str(input["platform"]);
    const udid = selector(input["udid"]);
    const serial = selector(input["serial"]);

    if (["ios", "macos", "apple"].includes(platform) && udid && !serial) {
      activity.platform = platform;
      activity.deviceId = udid;
    } else if (["android", "harmonyos", "vega"].includes(platform) && serial && !udid) {
      activity.platform = platform;
      activity.deviceId = serial;
    }
  } else if (tool === AgentTool.DESKTOP && ["desktop_snapshot", "desktop_find", "desktop_screenshot"].includes(name)) {
    // Pinned desktop MCP flattens WindowScope and names --window-id `window_id`.
    // Ref actions carry a private RefEntry; its source window cannot be inferred.
    const windowId = selector(input["window_id"]);
    const app = str(input["app"]);

    if (!input["window_id"] || windowId) {
      activity.windowId = windowId;
      activity.app = /^[\p{L}\p{N}][\p{L}\p{N} ._()+-]{0,127}$/u.test(app) ? app : "";
    }
  }

  return activity;
}
