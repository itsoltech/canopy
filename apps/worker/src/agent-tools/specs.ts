import { AgentTool } from "@canopy/contracts";

export interface AgentToolSpec {
  readonly tool: AgentTool;
  readonly executable: string;
  readonly packageName: string;
  readonly version: string;
  readonly label: string;
  readonly screenshot: boolean;
  readonly stream: boolean;
  readonly runtime: boolean;
}

export const AGENT_TOOL_SPECS: readonly AgentToolSpec[] = [
  {
    tool: AgentTool.BROWSER,
    executable: "agent-browser",
    packageName: "agent-browser",
    version: "0.43.0",
    label: "agent-browser",
    screenshot: true,
    stream: true,
    runtime: true,
  },
  {
    tool: AgentTool.DESKTOP,
    executable: "agent-desktop",
    packageName: "agent-desktop",
    version: "1.3.1",
    label: "agent-desktop",
    screenshot: true,
    stream: false,
    runtime: false,
  },
  {
    tool: AgentTool.DEVICE,
    executable: "agent-device",
    packageName: "agent-device",
    version: "0.21.37",
    label: "agent-device",
    screenshot: true,
    stream: false,
    runtime: false,
  },
];

export const specOf = (tool: AgentTool): AgentToolSpec | undefined =>
  AGENT_TOOL_SPECS.find((item) => item.tool === tool);

export const agentToolSpec = (tool: AgentTool): AgentToolSpec => {
  const spec = specOf(tool);

  if (!spec) throw new Error("unknown automation tool");

  return spec;
};

export const operationNames = new Set(["open", "snapshot", "screenshot", "click", "fill", "type", "press", "close"]);

export const safeArgument = (value: string, label: string): string => {
  if (value.length > 16_384) throw new Error(`${label} is too long`);

  if (value.includes("\0")) throw new Error(`${label} contains an invalid character`);

  return value;
};
