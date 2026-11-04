/** Safe configuration evidence and MCP client shared by the fake official CLIs. */
import { appendFileSync } from "node:fs";
import { Schema } from "effect";

const Mcp = Schema.Struct({
  url: Schema.String,
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  http_headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

const McpConfig = Schema.Struct({ mcpServers: Schema.Record(Schema.String, Mcp) });
const CodexConfig = Schema.Struct({ mcp_servers: Schema.Record(Schema.String, Mcp) });

export function arg(name: string): string | undefined {
  const args = process.argv;
  const index = args.indexOf(name);

  return (
    args.find((v) => v.startsWith(`${name}=`))?.slice(name.length + 1) ?? (index >= 0 ? args[index + 1] : undefined)
  );
}

export function botEvidence(provider: string, isolated: boolean, names: string[] = []): void {
  const trace = process.env["BOT_TRACE"];

  if (trace) appendFileSync(trace, JSON.stringify({ provider, isolated, names }) + "\n");
}

export function claudeBotConfig() {
  const value = arg("--mcp-config");

  if (!process.env["BOT_TRACE"] || !value) return undefined;
  const config = Schema.decodeSync(Schema.fromJsonString(McpConfig))(value);
  botEvidence("claude", arg("--tools") === "" && process.argv.includes("--strict-mcp-config"));

  return config.mcpServers["canopy"];
}

export function codexBotConfig(config: Schema.Json) {
  if (!process.env["BOT_TRACE"]) return undefined;
  const parsed = Schema.decodeUnknownSync(CodexConfig)(config);
  botEvidence(
    "codex",
    process.argv.includes("features.shell_tool=false") && process.argv.includes('web_search="disabled"'),
  );

  return parsed.mcp_servers["canopy"];
}

export async function botTool(text: string, server: typeof Mcp.Type | undefined): Promise<string> {
  const name = text.match(/TOOL:([a-z_]+)/)?.[1];

  if (!server || !name) return "FIXTURE_OK";

  const response = await fetch(server.url, {
    method: "POST",
    headers: { ...server.headers, ...server.http_headers, "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: name === "create_project" ? { name: "Harness project" } : {} },
    }),
  });

  return `TOOL_RESULT:${JSON.stringify(await response.json())}`;
}
