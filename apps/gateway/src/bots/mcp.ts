import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JsonObject } from "@canopy/domain";
import { Schema } from "effect";
import type { McpConnection, ToolSpec } from "./types.ts";
import { httpMcpFailure, McpFailure, networkMcpFailure, protocolMcpFailure, type McpPhase } from "./mcp-errors.ts";

type McpResult = Awaited<ReturnType<Client["callTool"]>>;

const isStructuredResult = Schema.is(Schema.JsonObject);

const MAX_MCP_TEXT_BYTES = 100_000;
const MAX_MCP_IMAGE_RESULT_BYTES = 1_000_000;
const resultBytes = (result: McpResult) => Buffer.byteLength(JSON.stringify(result));

function boundedMcpResult(result: McpResult): McpResult {
  const bytes = resultBytes(result);

  if (bytes <= MAX_MCP_TEXT_BYTES) return result;

  if ("content" in result && Array.isArray(result.content)) {
    const content = result.content.filter((block) => block.type !== "image");

    if (content.length < result.content.length) {
      const withoutImages = { ...result, content };

      if (resultBytes(withoutImages) <= MAX_MCP_TEXT_BYTES && bytes <= MAX_MCP_IMAGE_RESULT_BYTES) return result;

      if (content.length || result.structuredContent) {
        content.push({ type: "text", text: "Canopy omitted images that exceeded the connector response limit." });

        if (resultBytes(withoutImages) <= MAX_MCP_TEXT_BYTES) return withoutImages;
      }
    }
  }

  if (isStructuredResult(result.structuredContent)) {
    const metadata: McpResult = {
      structuredContent: result.structuredContent,
      isError: result.isError === true,
      content: [{ type: "text", text: "Canopy omitted bulky content. The structured result is available." }],
    };

    if (resultBytes(metadata) <= MAX_MCP_TEXT_BYTES) return metadata;
  }

  return {
    isError: true,
    content: [{ type: "text", text: "The connector response exceeded Canopy’s size limit." }],
  };
}

/** The SDK has already parsed the wire JSON; this only states it in the gateway's JSON type. */
const toolSchema = Schema.decodeUnknownSync(Schema.JsonObject);

/** Only the two remote transports are imported. No stdio or process launcher exists here. */
export async function withMcp<A>(
  server: McpConnection,
  signal: AbortSignal,
  use: (client: Client) => Promise<A>,
  requestPhase: McpPhase = "tools/call",
): Promise<A> {
  if (!server.enabled) throw new Error("MCP server is disabled");
  const url = new URL(server.url);
  const headers = new Headers(server.headers);
  let phase: McpPhase = "initialize";
  let failure: McpFailure | undefined;

  const safeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const target = new URL(input instanceof Request ? input.url : String(input));

    if (target.origin !== url.origin) throw new Error("MCP endpoint changed origin");

    let response: Response;

    try {
      response = await fetch(input, {
        ...init,
        headers: new Headers({ ...Object.fromEntries(new Headers(init?.headers)), ...Object.fromEntries(headers) }),
        redirect: "error",
        signal,
      });
    } catch (cause) {
      failure = networkMcpFailure(cause, phase, signal);
      throw failure;
    }

    // A Streamable HTTP server may decline the optional GET stream or session DELETE.
    if (!response.ok && (init?.method === "POST" || server.transport === "sse")) {
      failure = await httpMcpFailure(response, phase);
      throw failure;
    }

    return response;
  };

  const transport =
    server.transport === "sse"
      ? new SSEClientTransport(url, {
          fetch: safeFetch,
          requestInit: { headers, redirect: "error" },
          eventSourceInit: { fetch: safeFetch },
        })
      : new StreamableHTTPClientTransport(url, {
          fetch: safeFetch,
          requestInit: { headers, redirect: "error" },
          reconnectionOptions: {
            maxRetries: 0,
            maxReconnectionDelay: 1000,
            initialReconnectionDelay: 1000,
            reconnectionDelayGrowFactor: 1,
          },
        });

  const client = new Client({ name: "Canopy", version: "1" }, { capabilities: {} });

  const abort = () => {
    void client.close().catch(() => undefined);
  };

  signal.addEventListener("abort", abort, { once: true });

  try {
    signal.throwIfAborted();
    await client.connect(transport);
    phase = requestPhase;

    return await use(client);
  } catch (cause) {
    throw protocolMcpFailure(failure ?? cause, phase, signal);
  } finally {
    signal.removeEventListener("abort", abort);
    await client.close().catch(() => undefined);
  }
}

export async function mcpTools(server: McpConnection, signal: AbortSignal): Promise<ToolSpec[]> {
  return withMcp(server, signal, (client) => listMcpTools(client, server, signal), "tools/list");
}

export async function listMcpTools(client: Client, server: McpConnection, signal: AbortSignal): Promise<ToolSpec[]> {
  const tools: ToolSpec[] = [];
  let cursor: string | undefined;

  do {
    const page = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: 15_000 });

    for (const t of page.tools) {
      const remote = t.name.replace(/[^a-zA-Z0-9_]/g, "_");

      const suffix =
        remote.length > 22 || remote !== t.name
          ? `${remote.slice(0, 13)}_${createHash("sha256").update(t.name).digest("hex").slice(0, 8)}`
          : remote;

      tools.push({
        name: server.namespace
          ? `${server.namespace.slice(0, 39)}__${suffix}`
          : `mcp_${createHash("sha256").update(`${server.id}/${t.name}`).digest("hex").slice(0, 24)}`,
        description: `${server.name}: ${t.description ?? t.name}`.slice(0, 8000),
        parameters: toolSchema(t.inputSchema),
        source: "mcp",
        serverId: server.id,
        serverName: server.name,
        remoteName: t.name,
        readOnly: t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint !== true,
        dangerous: t.annotations?.destructiveHint === true,
      });
    }

    cursor = page.nextCursor;

    if (tools.length > 256) throw new Error("MCP tool catalog is too large");
  } while (cursor);

  return tools;
}

export async function mcpCall(
  server: McpConnection,
  tool: ToolSpec,
  args: JsonObject,
  signal: AbortSignal,
): Promise<McpResult> {
  return withMcp(server, signal, async (client) => {
    const result = await client.callTool({ name: tool.remoteName!, arguments: args }, undefined, {
      signal,
      timeout: 120_000,
    });

    return boundedMcpResult(result);
  });
}
