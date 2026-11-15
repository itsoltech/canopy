import { AgentTool, type AgentToolInfo } from "@canopy/contracts";

const DEVICE_PREVIEW_VERSION = "0.21.37";

/** An installed device tool can list targets before a device passes its readiness check. */
export function isPreviewReady(tool: AgentToolInfo | undefined): boolean {
  return tool?.tool === AgentTool.DEVICE
    ? tool.installed && tool.version === DEVICE_PREVIEW_VERSION && tool.install?.state !== "running"
    : Boolean(tool?.ready);
}
