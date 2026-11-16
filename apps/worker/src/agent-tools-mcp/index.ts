import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import { AutomationStdio, type LocalAutomationServer } from "./stdio.ts";
import { bindAutomationCall } from "./policy.ts";
import type { AutomationScope } from "./session-policy.ts";
import {
  abortable,
  Cancellation,
  failure,
  MAX_BYTES,
  MAX_PENDING,
  readRequest,
  requestDeadline,
  reply,
  ToolCall,
  type Rpc,
  type RpcId,
} from "./protocol.ts";

export type { LocalAutomationServer } from "./stdio.ts";

export interface LocalAutomationMcpOptions {
  servers: readonly LocalAutomationServer[];
  env: Record<string, string>;
  /** Reject unless this tool is enabled and the thread has a current, permitted active turn. */
  authorize(name: string, toolName: string, argsJson: string, signal: AbortSignal): Promise<void>;
}

export interface LocalAutomationMcp {
  servers: { name: string; url: string; headers: Record<string, string> }[];
  close(): Promise<void>;
}

interface Endpoint {
  name: string;
  scope: AutomationScope | undefined;
  token: string;
  stdio: AutomationStdio;
  pending: Map<RpcId, AbortController>;
}

/** Authenticated, stateless Streamable HTTP; commands and environment come only from the worker. */
export function createLocalAutomationMcp(options: LocalAutomationMcpOptions): LocalAutomationMcp {
  const endpoints = new Map<string, Endpoint>();

  for (const descriptor of options.servers) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(descriptor.name) || endpoints.has(`/mcp/${descriptor.name}`))
      throw new Error("Invalid or duplicate local automation server name");
    endpoints.set(`/mcp/${descriptor.name}`, {
      name: descriptor.name,
      scope: descriptor.scope,
      token: crypto.randomUUID(),
      stdio: new AutomationStdio(descriptor, options.env),
      pending: new Map(),
    });
  }

  const stopped = new AbortController();
  let active = 0;
  let closing: Promise<void> | undefined;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: MAX_BYTES,
    idleTimeout: 0,
    async fetch(request) {
      const endpoint = endpoints.get(new URL(request.url).pathname);

      if (!endpoint || request.headers.get("authorization") !== `Bearer ${endpoint.token}`)
        return new Response(null, { status: 401 });

      if (stopped.signal.aborted) return new Response(null, { status: 503 });

      if (request.method !== "POST") return new Response(null, { status: 405 });

      if (active >= MAX_PENDING * 2) return new Response(null, { status: 429 });
      active++;
      const deadline = requestDeadline([request.signal, stopped.signal]);

      try {
        const rpc = await readRequest(request, deadline.signal);

        return await handle(endpoint, options.authorize, rpc, deadline.signal);
      } catch {
        return new Response(null, { status: deadline.signal.aborted ? 408 : 400 });
      } finally {
        deadline.dispose();
        active--;
      }
    },
  });

  return {
    servers: [...endpoints].map(([path, endpoint]) => ({
      name: endpoint.name,
      url: `http://127.0.0.1:${server.port}${path}`,
      headers: { Authorization: `Bearer ${endpoint.token}` },
    })),
    close() {
      stopped.abort();
      closing ??= Promise.all([
        server.stop(true),
        ...[...endpoints.values()].map((endpoint) => endpoint.stdio.close()),
      ]).then(() => {});

      return closing;
    },
  };
}

async function handle(
  endpoint: Endpoint,
  authorize: LocalAutomationMcpOptions["authorize"],
  rpc: Rpc,
  requestSignal: AbortSignal,
): Promise<Response> {
  if (rpc.id === undefined) {
    if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });

    if (rpc.method !== "notifications/cancelled") return new Response(null, { status: 400 });
    const cancellation = Cancellation.safeParse(rpc.params);

    if (!cancellation.success) return new Response(null, { status: 400 });
    endpoint.pending.get(cancellation.data.requestId)?.abort();

    return new Response(null, { status: 202 });
  }

  if (endpoint.pending.has(rpc.id)) return failure(rpc.id, -32600, "Duplicate request id");

  if (endpoint.pending.size >= MAX_PENDING) return failure(rpc.id, -32000, "Too many local automation requests");

  if (!["initialize", "ping", "tools/list", "tools/call"].includes(rpc.method))
    return failure(rpc.id, -32601, "Unknown method");
  const controller = new AbortController();
  endpoint.pending.set(rpc.id, controller);
  const signal = AbortSignal.any([requestSignal, controller.signal]);

  try {
    if (rpc.method === "ping") return reply(rpc.id, {});

    if (rpc.method === "initialize") {
      await endpoint.stdio.initialize(signal);
      const requestedVersion = rpc.params?.["protocolVersion"];
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.find((version) => version === requestedVersion);

      return reply(rpc.id, {
        protocolVersion: protocolVersion ?? LATEST_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: endpoint.name, version: "1" },
      });
    }

    if (rpc.method === "tools/list") return reply(rpc.id, await endpoint.stdio.list(signal));
    const params = ToolCall.safeParse(rpc.params);

    if (!params.success) return failure(rpc.id, -32602, "Invalid tool arguments");
    let effective: ReturnType<typeof bindAutomationCall>;

    try {
      effective = bindAutomationCall(params.data, endpoint.scope);
    } catch (error) {
      return failure(rpc.id, -32602, error instanceof Error ? error.message : "Invalid automation arguments");
    }

    try {
      await abortable(authorize(endpoint.name, effective.name, JSON.stringify(effective.arguments), signal), signal);
      signal.throwIfAborted();
    } catch {
      return failure(rpc.id, -32001, signal.aborted ? "Local automation request cancelled" : "Local automation denied");
    }

    const result = await endpoint.stdio.call(effective, signal);

    return result ? reply(rpc.id, result) : failure(rpc.id, -32601, "Unknown tool");
  } catch {
    return failure(rpc.id, -32603, signal.aborted ? "Local automation request cancelled" : "Local automation failed");
  } finally {
    endpoint.pending.delete(rpc.id);
  }
}
