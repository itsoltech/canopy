import { AgentTool, type RunAgentTool } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";

export const AGENT_TOOLS = new Set([AgentTool.BROWSER, AgentTool.DESKTOP, AgentTool.DEVICE]);
export const AGENT_WORKER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPERATIONS = new Set(["open", "snapshot", "screenshot", "click", "fill", "type", "press", "close"]);
const DEVICE_PLATFORMS = new Set(["ios", "android", "harmonyos", "vega", "macos", "linux", "web", "apple"]);

export function agentToolWorkerId(value: string): string {
  if (!AGENT_WORKER_ID.test(value)) throw new ConnectError("invalid worker id", Code.InvalidArgument);

  return value.toLowerCase();
}

export function validateAgentTool(tool: AgentTool): void {
  if (!AGENT_TOOLS.has(tool)) throw new ConnectError("unknown automation tool", Code.InvalidArgument);
}

function validateArgument(label: string, value: string): void {
  if (value.length > 16_384) throw new ConnectError(`${label} is too long`, Code.InvalidArgument);

  for (const character of value) {
    const code = character.charCodeAt(0);
    const textWhitespace = label === "value" && (code === 9 || code === 10 || code === 13);

    if (!textWhitespace && (code < 32 || (code >= 127 && code <= 159)))
      throw new ConnectError(`${label} contains an invalid character`, Code.InvalidArgument);
  }
}

export function validateAgentToolOperation(operation: RunAgentTool): void {
  validateAgentTool(operation.tool);

  if (!OPERATIONS.has(operation.operation))
    throw new ConnectError("unsupported automation operation", Code.InvalidArgument);

  for (const [label, value] of Object.entries({
    target: operation.target,
    value: operation.value,
    platform: operation.platform,
    session: operation.session,
    app: operation.app,
    windowId: operation.windowId,
    deviceId: operation.deviceId,
  }))
    validateArgument(label, value);

  if (operation.platform && (operation.tool !== AgentTool.DEVICE || !DEVICE_PLATFORMS.has(operation.platform)))
    throw new ConnectError("unsupported device platform", Code.InvalidArgument);

  for (const [label, value] of Object.entries({
    session: operation.session,
    app: operation.app,
    windowId: operation.windowId,
    deviceId: operation.deviceId,
  })) {
    if (value && (!value.trim() || value.startsWith("-")))
      throw new ConnectError(`${label} must be a non-option argument`, Code.InvalidArgument);
  }

  if (operation.tool === AgentTool.BROWSER && (operation.app || operation.windowId || operation.deviceId))
    throw new ConnectError("browser operations do not support app, window or device selectors", Code.InvalidArgument);

  if (operation.windowId && operation.tool !== AgentTool.DESKTOP)
    throw new ConnectError("only agent-desktop supports a window selector", Code.InvalidArgument);

  if (operation.deviceId && operation.tool !== AgentTool.DEVICE)
    throw new ConnectError("only agent-device supports a device selector", Code.InvalidArgument);

  if (operation.tool === AgentTool.DEVICE && operation.app && !["open", "close"].includes(operation.operation))
    throw new ConnectError("device app selectors require open or close", Code.InvalidArgument);

  if (operation.tool === AgentTool.DESKTOP) {
    if (operation.windowId && ["open", "close"].includes(operation.operation))
      throw new ConnectError("desktop open and close require an app without a window selector", Code.InvalidArgument);

    if ((operation.app || operation.windowId) && ["click", "fill", "type"].includes(operation.operation))
      throw new ConnectError(
        "desktop ref actions use the ref's window; omit app and window selectors",
        Code.InvalidArgument,
      );
  }

  if (operation.deviceId && !["ios", "macos", "apple", "android", "harmonyos", "vega"].includes(operation.platform))
    throw new ConnectError(
      "device IDs require an explicit Apple, Android, HarmonyOS or Vega platform",
      Code.InvalidArgument,
    );
}
