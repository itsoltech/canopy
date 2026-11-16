import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { DEFAULT_INHERITED_ENV_VARS, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CallToolResultSchema,
  ListToolsResultSchema,
  type ListToolsRequest,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { abortable, MAX_BYTES, requestDeadline, STDIO_TIMEOUT_MS, type ToolCall } from "./protocol.ts";
import { browserCatalog } from "./browser-policy.ts";

export interface LocalAutomationServer {
  name: string;
  command: string;
  args: readonly string[];
  readonly env?: Readonly<{ AGENT_BROWSER_SESSION?: string; AGENT_DEVICE_SESSION?: string }>;
}

/** The SDK also closes on framing failures; join that shutdown rather than racing a second close. */
class AutomationTransport extends StdioClientTransport {
  private closing: Promise<void> | undefined;

  override close(): Promise<void> {
    this.closing ??= super.close();

    return this.closing;
  }
}

/** One lazily started, isolated stdio process for one approved local executable. */
export class AutomationStdio {
  private readonly client = new Client({ name: "Canopy", version: "1" });
  private readonly transport: AutomationTransport;
  private readonly stopped = new AbortController();
  private readonly exited = Promise.withResolvers<void>();
  private childStarted = false;
  private connected: Promise<void> | undefined;
  private catalog: Promise<{ tools: Tool[] }> | undefined;
  private closing: Promise<void> | undefined;
  private readonly browserSession: string | undefined;

  constructor(server: LocalAutomationServer, env: Record<string, string>) {
    this.browserSession = server.env?.AGENT_BROWSER_SESSION;
    // The SDK merges its default environment even with an explicit env. Mask omitted values.
    const isolatedEnv = Object.fromEntries(DEFAULT_INHERITED_ENV_VARS.map((key) => [key, ""]));
    Object.assign(isolatedEnv, env);
    // MCP session defaults belong to this descriptor, never to the worker's ambient environment.
    delete isolatedEnv["AGENT_BROWSER_SESSION"];
    delete isolatedEnv["AGENT_DEVICE_SESSION"];

    if (server.env?.AGENT_BROWSER_SESSION !== undefined)
      isolatedEnv["AGENT_BROWSER_SESSION"] = server.env.AGENT_BROWSER_SESSION;

    if (server.env?.AGENT_DEVICE_SESSION !== undefined)
      isolatedEnv["AGENT_DEVICE_SESSION"] = server.env.AGENT_DEVICE_SESSION;
    this.transport = new AutomationTransport({
      command: server.command,
      args: [...server.args],
      env: isolatedEnv,
      stderr: "ignore",
      maxBufferSize: MAX_BYTES,
    });
    this.transport.onclose = () => this.exited.resolve();
  }

  async initialize(signal: AbortSignal): Promise<void> {
    this.stopped.signal.throwIfAborted();
    this.connected ??= this.connect();
    await abortable(this.connected, signal);
    signal.throwIfAborted();
  }

  private async connect(): Promise<void> {
    const deadline = requestDeadline([this.stopped.signal], STDIO_TIMEOUT_MS);

    try {
      const connecting = this.client.connect(this.transport, { signal: deadline.signal, timeout: STDIO_TIMEOUT_MS });
      this.childStarted = this.transport.pid !== null;
      await abortable(connecting, deadline.signal);
      deadline.signal.throwIfAborted();
    } catch {
      await this.close();
      throw new Error("Local automation initialization failed");
    } finally {
      deadline.dispose();
    }
  }

  async list(signal: AbortSignal): Promise<{ tools: Tool[] }> {
    await this.initialize(signal);
    this.catalog ??= this.loadTools();

    return abortable(this.catalog, signal);
  }

  private async loadTools(): Promise<{ tools: Tool[] }> {
    const deadline = requestDeadline([this.stopped.signal], STDIO_TIMEOUT_MS);
    const tools: Tool[] = [];
    let cursor: string | undefined;
    let size = 0;

    try {
      for (let page = 0; page < 32; page++) {
        const request: ListToolsRequest = { method: "tools/list" };

        if (cursor) request.params = { cursor };

        const result = await this.client.request(request, ListToolsResultSchema, {
          signal: deadline.signal,
          timeout: STDIO_TIMEOUT_MS,
        });

        size += Buffer.byteLength(JSON.stringify(result));

        if (size > MAX_BYTES) throw new Error("Local automation catalog too large");
        tools.push(...result.tools);
        cursor = result.nextCursor;

        if (!cursor) return { tools: browserCatalog(tools, this.browserSession) };
      }

      throw new Error("Local automation catalog has too many pages");
    } finally {
      deadline.dispose();
    }
  }

  async call(params: z.infer<typeof ToolCall>, signal: AbortSignal) {
    const catalog = await this.list(signal);

    if (!catalog.tools.some((tool) => tool.name === params.name)) return undefined;
    signal.throwIfAborted();

    return this.client.request({ method: "tools/call", params }, CallToolResultSchema, {
      signal,
      timeout: STDIO_TIMEOUT_MS,
    });
  }

  close(): Promise<void> {
    this.stopped.abort();
    this.closing ??= this.shutdown();

    return this.closing;
  }

  private async shutdown(): Promise<void> {
    try {
      await this.client.close();
    } finally {
      await this.transport.close();

      if (this.childStarted) {
        const deadline = requestDeadline([], 1_000);

        try {
          await abortable(this.exited.promise, deadline.signal);
        } finally {
          deadline.dispose();
        }
      }
    }
  }
}
