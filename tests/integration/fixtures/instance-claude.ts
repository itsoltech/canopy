#!/usr/bin/env bun
/** Claude Code stream-json fixture; the real SDK reads these persisted sessions on resume. */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { JsonObject } from "@canopy/domain";
import { Match, Schema } from "effect";
import { recordInput, recordProbe, releaseProbe } from "./instance-probe.ts";
import { botFailure, botTool, claudeBotConfig } from "./bot-probe.ts";
import { archivedBackground } from "./instance-background.ts";
import { sdkInventory } from "./instance-mcp.ts";

if (process.argv.includes("--version")) {
  console.log("Claude Code 2.1.316");
  process.exit();
}

const args = process.argv;
const resume = args.find((arg) => arg.startsWith("--resume="))?.slice("--resume=".length);

const session =
  resume ?? args.find((arg) => arg.startsWith("--session-id="))?.slice("--session-id=".length) ?? crypto.randomUUID();

const home = process.env["CLAUDE_CONFIG_DIR"]!;
const folder = join(home, "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-"));

mkdirSync(folder, { recursive: true });

const transcript = join(folder, `${session}.jsonl`);
const send = (message: JsonObject) => process.stdout.write(JSON.stringify(message) + "\n");
const inventory = sdkInventory(send);
let configured = Promise.resolve();

recordProbe("claude", resume ? "resume" : "spawn", session);

const botMcp = claudeBotConfig();
let instructions = "";

async function turn(text: string): Promise<void> {
  recordProbe("claude", "turn", session, "", inventory.tools);
  send({
    type: "system",
    subtype: "init",
    session_id: session,
    uuid: crypto.randomUUID(),
    tools: [],
    model: "fixture-model",
    cwd: process.cwd(),
  });

  if (text.includes("BACKGROUND_ARCHIVE_TEST")) {
    await archivedBackground(session, send);

    return;
  }

  if (text.includes("CONNECTOR_BACKGROUND"))
    send({
      type: "system",
      subtype: "task_started",
      session_id: session,
      uuid: crypto.randomUUID(),
      task_id: "connector-background",
      tool_use_id: "connector-task-tool",
      description: "Fixture background task",
      is_backgrounded: true,
      task_type: "local_bash",
    });

  if (text.split("\n\nCurrent input:\n").at(-1)?.includes("STOP_REPLY")) {
    const stream = (event: JsonObject) =>
      send({ type: "stream_event", session_id: session, uuid: crypto.randomUUID(), event, parent_tool_use_id: null });

    stream({
      type: "message_start",
      message: {
        id: "partial",
        type: "message",
        role: "assistant",
        content: [],
        model: "fixture-model",
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    });
    stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Partial reply" } });
  }

  await releaseProbe(text);
  const failure = process.env["BOT_TRACE"] ? botFailure(text) : undefined;

  if (failure) {
    if (text.includes("FAIL:exit")) process.exit(7);

    if (text.includes("FAIL:auth"))
      send({
        type: "assistant",
        session_id: session,
        uuid: crypto.randomUUID(),
        parent_tool_use_id: null,
        error: "authentication_failed",
        message: {
          id: crypto.randomUUID(),
          role: "assistant",
          content: [{ type: "text", text: failure.message }],
        },
      });

    send({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: [failure.message],
      usage: {},
      session_id: session,
    });

    return;
  }

  const answer = await botTool(text, botMcp, instructions);

  const user = {
    type: "user",
    uuid: crypto.randomUUID(),
    sessionId: session,
    cwd: process.cwd(),
    timestamp: new Date().toISOString(),
    parentUuid: null,
    isSidechain: false,
    message: { role: "user", content: text },
  };

  const assistant = {
    type: "assistant",
    uuid: crypto.randomUUID(),
    sessionId: session,
    session_id: session,
    cwd: process.cwd(),
    timestamp: new Date().toISOString(),
    parentUuid: user.uuid,
    isSidechain: false,
    parent_tool_use_id: null,
    message: {
      id: crypto.randomUUID(),
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: answer }],
      model: "fixture-model",
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  };

  appendFileSync(transcript, JSON.stringify(user) + "\n" + JSON.stringify(assistant) + "\n");

  if (text.includes("CRASH_AFTER_TRANSCRIPT")) process.exit(42);

  if (process.env["BOT_TRACE"]) {
    // SDK assistant messages contain individual blocks; thinking shifts the text's stream index.
    const stream = (event: JsonObject) =>
      send({ type: "stream_event", session_id: session, uuid: crypto.randomUUID(), event, parent_tool_use_id: null });

    stream({
      type: "message_start",
      message: {
        id: assistant.message.id,
        type: "message",
        role: "assistant",
        content: [],
        model: "fixture-model",
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    });
    stream({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
    stream({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "Private fixture reasoning" },
    });
    stream({ type: "content_block_stop", index: 0 });
    stream({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
    stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: answer } });
    stream({ type: "content_block_stop", index: 1 });
  }

  send(assistant);
  recordProbe("claude", "finish", session);
  send({
    type: "result",
    subtype: "success",
    session_id: session,
    uuid: crypto.randomUUID(),
    is_error: false,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    result: answer,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
    permission_denials: text.includes("FAIL:MCP_POLICY")
      ? [{ tool_name: "mcp__canopy__create_bot", tool_use_id: "denied-tool", tool_input: {} }]
      : [],
    stop_reason: "end_turn",
  });
}

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);

  if (message.type === "control_request") {
    if (message.request.subtype === "mcp_message") {
      send({
        type: "control_response",
        response: { subtype: "success", request_id: message.request_id, response: {} },
      });
      continue;
    }

    void (async () => {
      if (message.request.subtype === "initialize")
        instructions = Schema.decodeUnknownSync(Schema.Array(Schema.String))(message.request.systemPrompt ?? []).join(
          "\n",
        );

      if (message.request.subtype === "initialize" || message.request.subtype === "mcp_set_servers")
        configured = inventory.configure(
          message.request.subtype === "initialize"
            ? message.request.sdkMcpServers?.includes("canopy")
            : !!message.request.servers?.canopy,
        );
      await configured;
      send({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: message.request_id,
          response: Match.value(message.request.subtype).pipe(
            Match.when("mcp_status", () => ({ mcpServers: inventory.status() })),
            Match.when("mcp_set_servers", () => ({ added: [], removed: [], errors: {} })),
            Match.orElse(() => ({ commands: [], models: [], agents: [] })),
          ),
        },
      });
    })();
  } else if (message.type === "control_response") {
    inventory.response(message.response.request_id, message.response.response ?? {});
  } else if (message.type === "user") {
    if (message.uuid)
      send({ type: "command_lifecycle", command_uuid: message.uuid, state: "started", session_id: session });

    const content = Schema.decodeSync(
      Schema.Union([
        Schema.String,
        Schema.Array(
          Schema.Struct({
            type: Schema.String,
            text: Schema.optional(Schema.String),
            source: Schema.optional(Schema.Struct({ media_type: Schema.String })),
          }),
        ),
      ]),
    )(message.message.content);

    const parts = Schema.is(Schema.String)(content)
      ? [{ type: "text", text: content }]
      : content.map((part) => ({ type: part.type, text: part.text, image: part.source?.media_type }));

    recordInput("claude", parts);
    void configured.then(() => turn(parts.map((part) => part.text ?? "").join("\n")));
  }
}
