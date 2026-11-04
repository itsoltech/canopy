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
  text = text.split("\n\nCurrent input:\n").at(-1) ?? text;
  const name = text.match(/TOOL:([a-z_0-9]+)/i)?.[1];

  if (!server || !name) return "FIXTURE_OK";
  const encoded = text.match(/ARGS:(.+)/)?.[1];

  const args = encoded
    ? Schema.decodeSync(Schema.fromJsonString(Schema.JsonObject))(encoded)
    : name === "create_project"
      ? { name: "Harness project" }
      : {};

  const response = await fetch(server.url, {
    method: "POST",
    headers: { ...server.headers, ...server.http_headers, "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });

  return `TOOL_RESULT:${JSON.stringify(await response.json())}`;
}

/** Provider-native failure fixtures contain deliberately unsafe prose to verify the transport boundary. */
export function botFailure(text: string) {
  const name = text
    .split("\n\nCurrent input:\n")
    .at(-1)
    ?.match(/FAIL:([a-z_]+)/)?.[1];

  const failures = {
    auth: { message: "Not signed in; login expired", codex: { httpConnectionFailed: { httpStatusCode: 401 } } },
    model: { message: "Model not found", codex: "modelNotFound" },
    usage: { message: "Usage limit reached", codex: "usageLimitExceeded" },
    proxy: { message: "Endpoint unavailable: invalid configuration", codex: "badRequest" },
    network: { message: "Connection timed out", codex: "httpConnectionFailed" },
    stream: { message: "Response stream disconnected", codex: "responseStreamDisconnected" },
    exit: { message: "CLI process exited (7)", codex: "processExit" },
  };

  const found = Object.entries(failures).find(([key]) => key === name)?.[1];

  return found
    ? {
        ...found,
        message: `${found.message}; https://private.invalid/api?token=fixture-secret; Bearer fixture-credential; echoed-private-prompt`,
      }
    : undefined;
}
