import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { AgentToolResultSchema, ConnectorToolSchema, type AgentToolCall } from "@canopy/contracts";
import type { ThreadEventInit } from "../../journal/index.ts";
import { grokBus } from "./bus.ts";

test("Grok MCP rejects unauthenticated/unknown tools and preserves connector account scope in gateway calls and items", async () => {
  const calls: AgentToolCall[] = [];
  const events: ThreadEventInit[] = [];

  const imageEnvelope = {
    content: [
      {
        type: "image",
        mimeType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      },
    ],
    structuredContent: { references: [{ id: "reference-1" }] },
  };

  const imageSummary = JSON.stringify({ ...imageEnvelope, content: [] });

  const bus = grokBus({
    threadId: "thread",
    depth: 0,
    turnId: () => "turn",
    agentBus: false,
    enableMemory: true,
    connectorTools: [
      create(ConnectorToolSchema, {
        accountId: "account",
        connectorType: "jira",
        accountName: "Work",
        name: "jira_issue",
        remoteName: "get_issue",
        inputSchemaJson: '{"type":"object"}',
      }),
    ],
    record: async (event) => {
      events.push(event);
    },
    callTool: async (call) => {
      calls.push(call);

      return call.argumentsJson === '{"id":"with-image"}'
        ? create(AgentToolResultSchema, {
            content: imageSummary,
            resultJson: JSON.stringify(imageEnvelope),
          })
        : create(AgentToolResultSchema, { content: '{"issue":"OK"}' });
    },
  });

  if (!("url" in bus.server)) throw new Error("HTTP MCP required");

  try {
    const request = {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "jira_issue", arguments: { id: "A-1" } },
      }),
    };

    expect((await fetch(bus.server.url, request)).status).toBe(401);
    expect(calls).toHaveLength(0);
    const headers = Object.fromEntries(bus.server.headers.map((h) => [h.name, h.value]));
    expect(
      ((await (await fetch(bus.server.url, { ...request, headers })).json()) as { result: unknown }).result,
    ).toBeTruthy();
    expect(calls[0]).toMatchObject({
      threadId: "thread",
      turnId: "turn",
      connectorAccountId: "account",
      toolName: "jira_issue",
      argumentsJson: '{"id":"A-1"}',
    });
    const body = events.at(-1)?.body;
    expect(body?.case === "itemCompleted" && body.value.item?.content).toMatchObject({
      case: "toolCall",
      value: {
        connectorAccountId: "account",
        connectorAccountName: "Work",
        connectorType: "jira",
        output: '{"issue":"OK"}',
      },
    });

    const imageResponse = await fetch(bus.server.url, {
      ...request,
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "jira_issue", arguments: { id: "with-image" } },
      }),
    });

    expect(await imageResponse.json()).toMatchObject({
      result: {
        content: [{ type: "text", text: imageSummary }, ...imageEnvelope.content],
      },
    });

    const denied = await fetch(bus.server.url, {
      ...request,
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "spawn_thread" } }),
    });

    expect(((await denied.json()) as { error: unknown }).error).toBeTruthy();
    expect(calls).toHaveLength(2);
    await fetch(bus.server.url, {
      ...request,
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "memory_search", arguments: { queries: ["release"] } },
      }),
    });
    expect(calls[2]).toMatchObject({
      threadId: "thread",
      turnId: "turn",
      toolName: "memory_search",
      connectorAccountId: "",
      argumentsJson: '{"queries":["release"]}',
    });
  } finally {
    bus.close();
  }
});
