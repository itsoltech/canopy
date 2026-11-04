#!/usr/bin/env bun
/** Deterministic process fixture for the complete gateway↔worker ACP path. */
import { createInterface } from "node:readline";
import { join } from "node:path";

if (process.argv.includes("--version")) {
  console.log("grok 1.0.70 (fake)");
  process.exit();
}

const send = (value: object) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");

const update = (sessionId: string, value: object) =>
  send({ method: "session/update", params: { sessionId, update: value } });

const sessions = new Map<
  string,
  { cwd: string; mcpServers: { url: string; headers: { name: string; value: string }[] }[] }
>();

const pending = new Map<string, { id: number; sessionId: string }>();
let hanging: { id: number; sessionId: string } | undefined;

for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);

  if (m.method === "initialize")
    send({
      id: m.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } },
        _meta: {
          modelState: {
            currentModelId: "fake-grok",
            availableModels: [
              {
                modelId: "fake-grok",
                name: "Fake Grok",
                _meta: { reasoningEfforts: [{ id: "high" }, { id: "low", default: true }] },
              },
            ],
          },
        },
      },
    });
  else if (m.method === "session/new" || m.method === "session/load") {
    if (
      process.env["CANOPY_GROK_API_KEY"] &&
      (!process.env["XAI_API_KEY"] ||
        (await Bun.file(join(process.env["GROK_HOME"]!, "config.toml")).text()).includes(
          process.env["CANOPY_GROK_API_KEY"]!,
        ))
    )
      throw new Error("Proxy credentials were not isolated");
    const sessionId = m.params.sessionId ?? crypto.randomUUID();
    const file = join(process.env["GROK_HOME"]!, "sessions", sessionId + ".json");

    if (m.method === "session/load" && !(await Bun.file(file).exists())) {
      send({ id: m.id, error: { code: -32000, message: "Session missing" } });
      continue;
    }

    await Bun.write(file, JSON.stringify({ cwd: m.params.cwd }));
    sessions.set(sessionId, m.params);
    send({ id: m.id, result: { sessionId } });
  } else if (m.method === "session/prompt") {
    const { sessionId } = m.params;
    const text = m.params.prompt.map((c: { text?: string }) => c.text ?? "").join("\n");

    if (text.includes("HANG")) {
      hanging = { id: m.id, sessionId };
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Waiting" } });
      continue;
    }

    if (text.includes("PERMISSION")) {
      const id = crypto.randomUUID();
      pending.set(id, { id: m.id, sessionId });
      send({
        id,
        method: "session/request_permission",
        params: {
          sessionId,
          toolCall: { toolCallId: "permission", title: "write_file", kind: "edit", rawInput: { path: "hello.txt" } },
          options: [
            { optionId: "allow", kind: "allow_once", name: "Allow" },
            { optionId: "deny", kind: "reject_once", name: "Deny" },
          ],
        },
      });
      continue;
    }

    if (text.includes("MCP")) {
      const server = sessions.get(sessionId)!.mcpServers[0]!;

      const headers = {
        "content-type": "application/json",
        ...Object.fromEntries(server.headers.map((h) => [h.name, h.value])),
      };

      const rpc = async (method: string, params: unknown = {}) =>
        (
          await fetch(server.url, {
            method: "POST",
            headers,
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          })
        ).json() as Promise<{ result?: unknown }>;

      await rpc("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "fake", version: "1" },
      });
      await rpc("tools/list");
      const response = await rpc("tools/call", { name: "list_threads", arguments: {} });

      if (!response.result) throw new Error("MCP tool call failed");

      if (text.includes("IMAGE")) {
        const image = await rpc("tools/call", { name: "view_image", arguments: { path: "fixture.png" } });

        if (!(image.result as { content: { type: string }[] })?.content.some((c) => c.type === "image"))
          throw new Error("MCP image missing");
      }
    }

    update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking" } });
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "pwd",
      title: "run_terminal_command",
      rawInput: { command: "pwd" },
      status: "in_progress",
    });
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "pwd",
      status: "completed",
      rawOutput: { exit_code: 0 },
      content: [{ type: "content", content: { type: "text", text: sessions.get(sessionId)!.cwd } }],
    });
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "edit",
      kind: "edit",
      status: "completed",
      content: [{ type: "diff", path: "hello.txt", oldText: "old", newText: "new" }],
    });
    update(sessionId, { sessionUpdate: "plan", entries: [{ content: "Finish", status: "completed" }] });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "GROK_OK" } });
    send({ id: m.id, result: { stopReason: "end_turn" } });
  } else if (m.method === "session/cancel") {
    if (hanging) {
      send({ id: hanging.id, result: { stopReason: "cancelled" } });
      hanging = undefined;
    }
  } else if (pending.has(m.id)) {
    const prompt = pending.get(m.id)!;
    pending.delete(m.id);
    update(prompt.sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: m.result.outcome.optionId === "allow" ? "ALLOWED" : "DENIED" },
    });
    send({ id: prompt.id, result: { stopReason: "end_turn" } });
  } else if (m.id) send({ id: m.id, result: {} });
}
