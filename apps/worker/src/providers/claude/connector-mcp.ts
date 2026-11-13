import type { McpSdkServerConfigWithInstance, Query } from "@anthropic-ai/claude-agent-sdk";
import type { ConnectorTool } from "@canopy/contracts";
import { connectorSessionCatalog } from "@canopy/domain/connector-session";
import { BUS_SERVER } from "./mapping.ts";

/** SDK replacement preserves the query; native CLI attachment completes asynchronously. */
export function claudeConnectorRefresh(
  query: Pick<Query, "setMcpServers" | "mcpServerStatus">,
  initial: readonly ConnectorTool[],
  servers: (tools: readonly ConnectorTool[]) => Record<string, McpSdkServerConfigWithInstance>,
) {
  let catalog: string | undefined = JSON.stringify(connectorSessionCatalog(initial));
  let previous = initial.map((t) => t.name);

  return async (tools: readonly ConnectorTool[]) => {
    const next = JSON.stringify(connectorSessionCatalog(tools));
    const names = tools.map((t) => t.name);

    try {
      if (catalog !== next) {
        // SDK 0.3.316 retains a same-name instance, so remove before registering its replacement.
        catalog = undefined;
        await query.setMcpServers({});
        const result = await query.setMcpServers(servers(tools));

        if (Object.keys(result.errors).length) throw new Error("Claude could not load connector tools");
      }

      const deadline = performance.now() + 15_000;

      for (;;) {
        const status = (await query.mcpServerStatus()).find((s) => s.name === BUS_SERVER);
        const available = new Set(status?.tools?.map((t) => t.name.replace(/^mcp__canopy__/, "")));

        if (
          status?.status === "connected" &&
          names.every((name) => available.has(name)) &&
          previous.every((name) => names.includes(name) || !available.has(name))
        )
          break;

        if (status?.status === "failed" || status?.status === "needs-auth" || performance.now() >= deadline)
          throw new Error("Claude could not load connector tools");
        await Bun.sleep(50);
      }

      catalog = next;
      previous = names;
    } catch (error) {
      catalog = undefined;
      throw error;
    }
  };
}
