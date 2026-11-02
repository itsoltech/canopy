import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { AgentToolResultSchema, ConnectorToolSchema, type AgentToolCall } from "@open-agents/contracts";
import type { ThreadEventInit } from "../../journal/index.ts";
import { grokBus } from "./bus.ts";

test("Grok MCP rejects unauthenticated/unknown tools and preserves connector account scope in gateway calls and items", async () => {
  const calls: AgentToolCall[] = []; const events: ThreadEventInit[] = [];
  const bus = grokBus({ threadId: "thread", depth: 0, turnId: () => "turn", agentBus: false,
    connectorTools: [create(ConnectorToolSchema, { accountId: "account", connectorType: "jira", accountName: "Work", name: "jira_issue", remoteName: "get_issue", inputSchemaJson: '{"type":"object"}' })],
    record: async (event) => { events.push(event); }, callTool: async (call) => { calls.push(call); return create(AgentToolResultSchema, { content: '{"issue":"OK"}' }); },
  });
  if (!("url" in bus.server)) throw new Error("HTTP MCP required");
  try {
    const request = { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "jira_issue", arguments: { id: "A-1" } } }) };
    expect((await fetch(bus.server.url, request)).status).toBe(401);
    expect(calls).toHaveLength(0);
    const headers = Object.fromEntries(bus.server.headers.map((h) => [h.name, h.value]));
    expect((await (await fetch(bus.server.url, { ...request, headers })).json() as { result: unknown }).result).toBeTruthy();
    expect(calls[0]).toMatchObject({ threadId: "thread", turnId: "turn", connectorAccountId: "account", toolName: "jira_issue", argumentsJson: '{"id":"A-1"}' });
    const body = events.at(-1)?.body;
    expect(body?.case === "itemCompleted" && body.value.item?.content).toMatchObject({ case: "toolCall", value: { connectorAccountId: "account", connectorAccountName: "Work", connectorType: "jira", output: '{"issue":"OK"}' } });
    const denied = await fetch(bus.server.url, { ...request, headers, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "spawn_thread" } }) });
    expect((await denied.json() as { error: unknown }).error).toBeTruthy(); expect(calls).toHaveLength(1);
  } finally { bus.close(); }
});
