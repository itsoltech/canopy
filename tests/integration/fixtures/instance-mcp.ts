/** Native fixture inventories are loaded at session admission, never derived from UI grants. */
import { Schema } from "effect";
import type { JsonObject } from "@canopy/domain";

export const HttpMcp = Schema.Struct({
  url: Schema.String,
  http_headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

const Catalog = Schema.Struct({
  result: Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) }),
});

export async function httpTools(server: typeof HttpMcp.Type | undefined): Promise<string[]> {
  if (!server) return [];

  const response = await fetch(server.url, {
    method: "POST",
    headers: { ...server.http_headers, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

  return Schema.decodeUnknownSync(Catalog)(await response.json()).result.tools.map((t) => t.name);
}

/** The real SDK answers these MCP requests; retain a CLI-side cache like the official CLI. */
export function sdkInventory(send: (message: JsonObject) => void) {
  const pending = new Map<string, (response: JsonObject) => void>();
  let tools: string[] = [];
  let connected = false;

  const request = (method: string, params: JsonObject = {}) =>
    new Promise<JsonObject>((resolve) => {
      const id = crypto.randomUUID();
      pending.set(id, resolve);
      send({
        type: "control_request",
        request_id: id,
        request: { subtype: "mcp_message", server_name: "canopy", message: { jsonrpc: "2.0", id, method, params } },
      });
    });

  return {
    get tools() {
      return tools;
    },
    response(id: string, response: JsonObject) {
      pending.get(id)?.(response);
      pending.delete(id);
    },
    async configure(enabled: boolean) {
      tools = [];
      connected = enabled;

      if (enabled) {
        await request("initialize", {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "Canopy fixture", version: "1" },
        });
        const response = await request("tools/list");
        const decoded = Schema.decodeUnknownSync(Schema.Struct({ mcp_response: Catalog }))(response);
        tools = decoded.mcp_response.result.tools.map((t) => t.name);
      }
    },
    status() {
      return connected
        ? [{ name: "canopy", status: "connected", source: "sdk", tools: tools.map((name) => ({ name })) }]
        : [];
    },
  };
}
