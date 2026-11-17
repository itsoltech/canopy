import { create } from "@bufbuild/protobuf";
import {
  AgentTool,
  AgentToolSessionDefaultsSchema,
  BrowserSessionDefaultsSchema,
  DesktopSessionDefaultsSchema,
  DeviceSessionDefaultsSchema,
  type AgentToolSessionDefaults,
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
