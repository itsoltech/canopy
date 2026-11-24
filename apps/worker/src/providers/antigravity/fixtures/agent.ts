#!/usr/bin/env bun
/** Antigravity's ACP protocol, with deterministic model choices and a persisted exchange for restart tests. */
import { mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { isNumber, objectOf, objectsOf, parseObject, str, type JsonObject } from "@canopy/domain/json";

if (process.argv.includes("--version")) {
  console.log("1.5.16");
  process.exit();
}

const flag = (name: string) => {
  const index = process.argv.indexOf(name);

  return index === -1 ? undefined : process.argv[index + 1];
};

const geminiDir = flag("--gemini-dir");

if (!geminiDir || !isAbsolute(geminiDir) || !process.argv.includes("acp"))
  throw new Error("Expected an isolated Antigravity ACP launch");

const conversations = resolve(geminiDir, flag("--app-data-dir") || "antigravity-cli", "conversations");

mkdirSync(conversations, { recursive: true });

const send = (message: JsonObject) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");

const models = [
  { value: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
  { value: "gemini-4-carbon", name: "Gemini 4 Carbon" },
];

let model = models[0]!.value;
let effort = "low";
let mode = "default";
let sessionId = "";
let mcp: JsonObject | undefined;
let restored = false;
let activePrompt: number | undefined;

const target = resolve("review.txt");

const edit = {
  toolCallId: "edit",
  name: "write_file",
  title: "File review.txt",
  kind: "edit",
  rawInput: { Path: target, Content: "Review completed.", Overwrite: true },
  locations: [{ path: target }],
};

const stateFile = () => Bun.file(join(conversations, sessionId + ".db"));

const configOptions = () => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: model, options: models },
  {
    id: "thought_level",
    name: "Thinking Level",
    category: "thought_level",
    type: "select",
    currentValue: effort,
    options: [
      { value: "low", name: "Low" },
      model === models[0]!.value ? { value: "medium", name: "Medium" } : { value: "high", name: "High" },
    ],
  },
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: mode,
    options: [
      { value: "default", name: "Default" },
      { value: "accept-edits", name: "Accept edits" },
    ],
  },
];

const update = (value: JsonObject) => send({ method: "session/update", params: { sessionId, update: value } });
const say = (text: string) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

async function listThreads(server: JsonObject | undefined) {
  if (!server || !process.argv.includes("--process-per-session")) throw new Error("Canopy HTTP MCP unavailable");
  const headers = Object.fromEntries(objectsOf(server["headers"]).map((h) => [str(h["name"]), str(h["value"])]));

  const response = await fetch(str(server["url"]), {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_threads", arguments: {} },
    }),
  });

  const result = parseObject(await response.text());

  if (!response.ok || !result["result"] || objectOf(result["result"])["isError"])
    throw new Error("Canopy list_threads failed");
}

async function prompt(id: number, params: JsonObject) {
  const text = objectsOf(params["prompt"])
    .map((c) => str(c["text"]))
    .join("\n");

  if (text.includes("Review with approval")) {
    const busCall = {
      toolCallId: "list-threads",
      name: "mcp_canopy_list_threads",
      title: "List threads",
      kind: "other",
      rawInput: { toolSummary: "List threads" },
    };

    update({ sessionUpdate: "tool_call", ...busCall, status: "in_progress" });
    await listThreads(mcp);
    update({ sessionUpdate: "tool_call_update", ...busCall, status: "completed" });
    activePrompt = id;
    update({ sessionUpdate: "tool_call", ...edit, status: "in_progress" });
    send({
      id: "permission",
      method: "session/request_permission",
      params: {
        sessionId,
        toolCall: { ...edit, status: "pending" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      },
    });
  } else if (text.includes("Wait for interruption")) {
    activePrompt = id;
    say("Waiting for interruption");
  } else {
    say(restored ? `Restored: ${await stateFile().text()}` : "Fresh conversation");
    send({ id, result: { stopReason: "end_turn" } });
  }
}

for await (const line of createInterface({ input: process.stdin })) {
  const message = parseObject(line);
  const method = message["method"];
  const id = message["id"];
  const params = objectOf(message["params"]);

  if (method === "session/cancel" && activePrompt !== undefined) {
    send({ id: activePrompt, result: { stopReason: "cancelled" } });
    activePrompt = undefined;
  } else if (id === "permission" && activePrompt !== undefined) {
    const decision = objectOf(objectOf(message["result"])["outcome"])["optionId"];
    const answer = `${model}, ${effort}, ${decision}`;
    update({ sessionUpdate: "tool_call_update", ...edit, status: decision === "allow" ? "completed" : "failed" });
    await Bun.write(stateFile(), answer);
    say(answer);
    send({
      id: activePrompt,
      result: {
        stopReason: "end_turn",
        usage: {
          inputTokens: 15,
          outputTokens: 5,
          cachedReadTokens: 5,
          cachedWriteTokens: 0,
          thoughtTokens: 3,
          totalTokens: 25,
        },
      },
    });
    activePrompt = undefined;
  } else if (isNumber(id)) {
    switch (method) {
      case "initialize":
        send({
          id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: "Antigravity ACP Server", version: "1.5.16" },
            agentCapabilities: {
              loadSession: true,
              sessionCapabilities: { resume: {}, list: {}, close: {} },
              promptCapabilities: { image: true, embeddedContext: true },
              mcpCapabilities: { http: true },
              _meta: { antigravity: { systemPrompt: { append: true } } },
            },
          },
        });
        break;
      case "session/new":
      case "session/load":
      case "session/resume":
        restored = method !== "session/new";
        sessionId = restored ? str(params["sessionId"]) : crypto.randomUUID();

        if (restored && !(await stateFile().exists())) {
          send({ id, error: { code: -32602, message: "Session not found" } });
          break;
        }

        if (!restored) await Bun.write(stateFile(), "");
        mcp = objectsOf(params["mcpServers"]).find((s) => s["name"] === "canopy" && s["type"] === "http");
        send({ id, result: { ...(!restored && { sessionId }), configOptions: configOptions() } });
        break;
      case "session/set_config_option": {
        const value = str(params["value"]);

        const option = configOptions().find(
          (o) => o.id === params["configId"] && o.options.some((v) => v.value === value),
        );

        if (!option) {
          send({ id, error: { code: -32602, message: "Unknown session option" } });
          break;
        }

        if (option.id === "model") model = value;

        if (option.id === "thought_level") effort = value;

        if (option.id === "mode") mode = value;
        send({ id, result: { configOptions: configOptions() } });
        break;
      }

      case "session/prompt":
        await prompt(id, params);
        break;
      case "session/close":
        send({ id, result: {} });
        break;
      default:
        send({ id, error: { code: -32601, message: "Method not found" } });
    }
  }
}
