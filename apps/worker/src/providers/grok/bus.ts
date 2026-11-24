import { isPlatformServer } from "@canopy/domain";

export { platformMcp as grokBus, type PlatformMcpOptions as GrokBusOptions } from "../mcp-bus.ts";

/** Grok's use_tool identifies an MCP operation as server__tool. */
export function platformToolName(name: string): string | undefined {
  const match = /^(.+?)__(.+)$/.exec(name);

  return match && isPlatformServer(match[1]) ? match[2] : undefined;
}
