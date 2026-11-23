import { create } from "@bufbuild/protobuf";
import {
  AgentTool,
  AgentToolSessionDefaultsSchema,
  BrowserSessionDefaultsSchema,
  DesktopSessionDefaultsSchema,
  DeviceSessionDefaultsSchema,
  type AgentToolSessionDefaults,
  type ui,
} from "@canopy/contracts";

/** Normalize only this tool so unrelated saves do not interrupt an editor. */
export function sessionDefaults(value: AgentToolSessionDefaults | undefined, tool: AgentTool) {
  if (tool === AgentTool.BROWSER)
    return create(AgentToolSessionDefaultsSchema, {
      browser: value?.browser ?? create(BrowserSessionDefaultsSchema),
    });

  if (tool === AgentTool.DESKTOP)
    return create(AgentToolSessionDefaultsSchema, {
      desktop: value?.desktop ?? create(DesktopSessionDefaultsSchema),
    });

  return create(AgentToolSessionDefaultsSchema, {
    device: value?.device ?? create(DeviceSessionDefaultsSchema),
  });
}

export const agentTools: { tool: AgentTool; name: string; description: string }[] = [
  {
    tool: AgentTool.BROWSER,
    name: "Agent Browser",
    description: "Browse websites and interact with pages.",
  },
  {
    tool: AgentTool.DESKTOP,
    name: "Agent Desktop",
    description: "Use desktop apps and control windows.",
  },
  {
    tool: AgentTool.DEVICE,
    name: "Agent Device",
    description: "Use apps on devices, emulators and simulators.",
  },
];

export type ToolWorker = { worker: ui.Worker; computer: string; readOnly: string };

export const toolKey = (workerId: string, tool: AgentTool) => `${workerId}/${tool}`;

export const workerTool = (worker: ui.Worker, tool: AgentTool) =>
  worker.agentTools.find((item) => item.tool?.tool === tool);

export const viewportSizes = [
  { value: "", label: "Browser default" },
  { value: "1280x720", label: "1280 × 720" },
  { value: "1440x900", label: "1440 × 900" },
  { value: "1920x1080", label: "1920 × 1080" },
  { value: "390x844", label: "390 × 844" },
  { value: "custom", label: "Custom size" },
];

export const pageAppearances = [
  { value: "", label: "Browser default" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "no-preference", label: "No preference" },
];

export const devicePlatforms = [
  { value: "", label: "Any platform" },
  { value: "ios", label: "iOS" },
  { value: "android", label: "Android" },
  { value: "apple", label: "Apple" },
];
