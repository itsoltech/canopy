/** Scripted Codex peer: real JSON-RPC dispatch, dynamic tool items, and whitespace-only text deltas. */
import { createInterface } from "node:readline";
import type { JsonObject } from "@canopy/domain";
import { decodeJsonObject, jsonObject, jsonString } from "../../../apps/worker/src/providers/json.ts";
import { textChunks } from "./bus-text.ts";

const send = (message: JsonObject) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method: string, params: JsonObject) => send({ method, params });
const threadId = "bus-fixture-thread";
const turnId = "bus-fixture-turn";
let args: JsonObject = {};

for await (const line of createInterface({ input: process.stdin })) {
  const request = decodeJsonObject(JSON.parse(line));
  const id = request["id"];
  const params = jsonObject(request["params"]) ?? {};

  if (id === undefined) continue;

  if (request["method"] === "initialize") send({ id, result: { userAgent: "bus-fixture" } });
  else if (request["method"] === "thread/start") send({ id, result: { thread: { id: threadId, path: null } } });
  else if (request["method"] === "model/list") send({ id, result: { data: [], nextCursor: null } });
  else if (request["method"] === "mcpServerStatus/list")
    send({
      id,
      result: { data: [{ name: "canopy_connectors", runtimeStatus: "connected", tools: {} }], nextCursor: null },
    });
  else if (request["method"] === "turn/start") {
    const input = params["input"];
    const text = Array.isArray(input) ? jsonString(jsonObject(input[0])?.["text"]) : "";
    args = decodeJsonObject(JSON.parse(text ?? "{}"));
    send({ id, result: { turn: { id: turnId, status: "inProgress", items: [], error: null } } });
    notify("turn/started", { threadId, turn: { id: turnId, status: "inProgress", items: [], error: null } });
    notify("item/started", {
      threadId,
      turnId,
      item: {
        type: "mcpToolCall",
        id: "native-mcp-call",
        server: "canopy",
        tool: "send_message",
        arguments: args,
        status: "inProgress",
        appContext: null,
        result: null,
        error: null,
        durationMs: null,
      },
    });
    notify("item/started", {
      threadId,
      turnId,
      item: {
        type: "dynamicToolCall",
        id: "bus-call",
        namespace: "canopy",
        tool: "send_message",
        arguments: args,
        status: "inProgress",
        contentItems: null,
        success: null,
        durationMs: null,
      },
    });
    send({
      id: "bus-tool-request",
      method: "item/tool/call",
      params: { threadId, turnId, callId: "bus-call", namespace: "canopy", tool: "send_message", arguments: args },
    });
  } else if (id === "bus-tool-request") {
    notify("item/completed", {
      threadId,
      turnId,
      item: {
        type: "mcpToolCall",
        id: "native-mcp-call",
        server: "canopy",
        tool: "send_message",
        arguments: args,
        status: "completed",
        appContext: null,
        result: { content: [], structuredContent: null },
        error: null,
        durationMs: 1,
      },
    });
    notify("item/completed", {
      threadId,
      turnId,
      item: {
        type: "dynamicToolCall",
        id: "bus-call",
        namespace: "canopy",
        tool: "send_message",
        arguments: args,
        status: "completed",
        contentItems: [],
        success: true,
        durationMs: 1,
      },
    });
    notify("item/started", {
      threadId,
      turnId,
      item: { type: "agentMessage", id: "streamed-message", text: "", phase: "final_answer" },
    });

    // Includes token boundaries and whitespace-only deltas. Completion deliberately has no text:
    // a full final snapshot must not hide a dropped delta in the adapter or reducer.
    for (const delta of textChunks)
      notify("item/agentMessage/delta", { threadId, turnId, itemId: "streamed-message", delta });
    notify("item/completed", {
      threadId,
      turnId,
      item: { type: "agentMessage", id: "streamed-message", text: "", phase: "final_answer" },
    });
    notify("turn/completed", { threadId, turn: { id: turnId, status: "completed", items: [], error: null } });
  } else if (id !== undefined) send({ id, result: {} });
}
