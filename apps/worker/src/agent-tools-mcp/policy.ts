import { AgentTool } from "@canopy/contracts";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { bindBrowserCall, browserCatalog } from "./browser-policy.ts";
import { bindDeviceCall, deviceMcpCatalog } from "./device-policy.ts";
import { bindDesktopCall, desktopCatalog } from "./desktop-policy.ts";
import { bindSessionArguments, sessionCatalog, type AutomationCall, type AutomationScope } from "./session-policy.ts";

/** Every local automation adapter and its Preview use the same worker-owned thread scope. */
export function bindAutomationCall(params: AutomationCall, scope?: AutomationScope): AutomationCall {
  if (!scope) return params;

  const bound = {
    ...params,
    arguments: bindSessionArguments(params.arguments, scope.session, scope.tool !== AgentTool.DESKTOP),
  };

  switch (scope.tool) {
    case AgentTool.BROWSER:
      return bindBrowserCall(bound);
    case AgentTool.DEVICE:
      return bindDeviceCall(bound, scope.session);
    case AgentTool.DESKTOP:
      return bindDesktopCall(bound, scope.session);
    default:
      throw new Error("Unknown automation scope");
  }
}

export function automationCatalog(tools: Tool[], scope?: AutomationScope): Tool[] {
  if (!scope) return tools;
  const catalog = sessionCatalog(tools, scope);

  if (scope.tool === AgentTool.BROWSER) return browserCatalog(catalog);

  if (scope.tool === AgentTool.DESKTOP) return desktopCatalog(catalog, scope.session);

  if (scope.tool === AgentTool.DEVICE) return deviceMcpCatalog(catalog);

  return catalog;
}
