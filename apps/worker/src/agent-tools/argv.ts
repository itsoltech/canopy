import { AgentTool, type RunAgentTool } from "@canopy/contracts";
import { operationNames, safeArgument } from "./specs.ts";
import { agentToolScopeArgs } from "./scope.ts";

const DEVICE_PLATFORMS = new Set(["ios", "android", "harmonyos", "vega", "macos", "linux", "web", "apple"]);

const operand = (value: string, label: string): string => {
  if (!value.trim() || value.startsWith("-")) throw new Error(`${label} must be a non-option argument`);

  return value;
};

export function validateAgentToolCommand(command: RunAgentTool): void {
  for (const [label, value] of Object.entries({
    operation: command.operation,
    target: command.target,
    value: command.value,
    session: command.session,
    app: command.app,
    windowId: command.windowId,
    deviceId: command.deviceId,
    platform: command.platform,
  }))
    safeArgument(value, label);

  for (const [label, value] of Object.entries({
    session: command.session,
    app: command.app,
    windowId: command.windowId,
    deviceId: command.deviceId,
    platform: command.platform,
  })) {
    // oxlint-disable-next-line no-control-regex -- CLI selectors cannot contain terminal or argument control bytes.
    if (/[\x00-\x1f\x7f]/.test(value)) throw new Error(`${label} contains an invalid character`);

    if (value) operand(value, label);
  }

  if (!operationNames.has(command.operation)) throw new Error("Unsupported automation operation");

  if (command.platform && (command.tool !== AgentTool.DEVICE || !DEVICE_PLATFORMS.has(command.platform)))
    throw new Error("Unsupported device platform");

  if (command.tool === AgentTool.BROWSER && (command.app || command.windowId || command.deviceId))
    throw new Error("Browser operations do not accept app, window ID or device ID");

  if (command.tool === AgentTool.DESKTOP && command.deviceId)
    throw new Error("Desktop operations do not accept a device ID");

  if (command.tool === AgentTool.DEVICE && command.windowId)
    throw new Error("Device operations do not accept a window ID");
}

function browserArgs(command: RunAgentTool, screenshotPath: string): string[] {
  const { operation, target, value } = command;

  const prefix = [
    "--json",
    ...agentToolScopeArgs(command.tool, command),
    ...(operation === "open" ? ["--headed", "false"] : []),
    operation,
  ];

  if (operation === "screenshot") return [...prefix, screenshotPath];

  if (operation === "snapshot" || operation === "close") return prefix;

  if (operation === "press") return [...prefix, operand(value || target, "key")];

  if (operation === "fill" || operation === "type") return [...prefix, operand(target, "target"), "--", value];

  return [...prefix, operand(target, "target")];
}

function appOperand(app: string, target: string): string {
  if (app && target && app !== target) throw new Error("Choose one application in app or target");

  return operand(app || target, "app");
}

function desktopArgs(command: RunAgentTool, screenshotPath: string): string[] {
  const { operation, target, value, app, windowId } = command;
  const prefix = agentToolScopeArgs(command.tool, command);
  const window = windowId ? [`--window-id=${windowId}`] : [];

  if (operation === "open" || operation === "close") {
    if (windowId) throw new Error("Desktop open and close require an app, without a window ID");

    return [...prefix, operation === "open" ? "launch" : "close-app", "--", appOperand(app, target)];
  }

  if (operation === "snapshot" || operation === "screenshot") {
    const selectedApp = app || target;

    return [
      ...prefix,
      operation,
      ...(selectedApp ? [`--app=${operand(selectedApp, "app")}`] : []),
      ...window,
      ...(operation === "snapshot" ? ["-i"] : [screenshotPath]),
    ];
  }

  if (operation === "press") {
    const selectedApp = app || (target && value ? target : "");

    return [
      ...prefix,
      "press",
      ...(selectedApp ? [`--app=${operand(selectedApp, "app")}`] : []),
      ...window,
      "--",
      operand(value || target, "key"),
    ];
  }

  if (app || windowId) throw new Error("Desktop ref actions use the ref's window; omit app and window ID");

  if (!/^@[^\s:]+:e\d+$/.test(target)) throw new Error("Desktop actions require a qualified snapshot ref");

  if (operation === "fill" || operation === "type")
    return [...prefix, operation === "fill" ? "set-value" : "type", "--", target, value];

  return [...prefix, "click", "--", target];
}

function deviceArgs(command: RunAgentTool, screenshotPath: string): string[] {
  const { operation, target, value, app } = command;
  const options = ["--json", ...agentToolScopeArgs(command.tool, command)];

  if (app && operation !== "open" && operation !== "close")
    throw new Error("Device app is supported only for open and close");

  if (operation === "screenshot") return [...options, "screenshot", "--", screenshotPath];

  if (operation === "snapshot") return [...options, "snapshot", "-i"];

  if (operation === "open") return [...options, "open", "--", appOperand(app, target)];

  if (operation === "close") return [...options, "close", ...(app || target ? ["--", appOperand(app, target)] : [])];

  if (operation === "type") {
    if (target) throw new Error("Device type writes to the focused field; use fill to target a field");

    return [...options, "type", "--", value];
  }

  if (operation === "fill") return [...options, "fill", "--", operand(target, "target"), value];

  return [...options, operation, "--", operand(target, "target")];
}

/** Each adapter owns its fixed CLI grammar. User values never become flags or command names. */
export function agentToolOperationArgs(command: RunAgentTool, screenshotPath: string): string[] {
  validateAgentToolCommand(command);

  if (command.tool === AgentTool.BROWSER) return browserArgs(command, screenshotPath);

  if (command.tool === AgentTool.DESKTOP) return desktopArgs(command, screenshotPath);

  if (command.tool === AgentTool.DEVICE) return deviceArgs(command, screenshotPath);

  throw new Error("Unknown automation tool");
}
