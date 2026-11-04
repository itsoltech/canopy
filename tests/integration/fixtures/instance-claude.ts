#!/usr/bin/env bun
/** Claude Code stream-json fixture; the real SDK reads these persisted sessions on resume. */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { JsonObject } from "@canopy/domain";
import { Schema } from "effect";
import { recordProbe, releaseProbe } from "./instance-probe.ts";

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

recordProbe("claude", resume ? "resume" : "spawn", session);

async function turn(text: string): Promise<void> {
  recordProbe("claude", "turn", session);
  send({
    type: "system",
    subtype: "init",
    session_id: session,
    uuid: crypto.randomUUID(),
    tools: [],
    model: "fixture-model",
    cwd: process.cwd(),
  });
  await releaseProbe(text);

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
      content: [{ type: "text", text: "FIXTURE_OK" }],
      model: "fixture-model",
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  };

  appendFileSync(transcript, JSON.stringify(user) + "\n" + JSON.stringify(assistant) + "\n");
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
    result: "FIXTURE_OK",
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
    permission_denials: [],
    stop_reason: "end_turn",
  });
}

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);

  if (message.type === "control_request")
    send({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response: { commands: [], models: [], agents: [] },
      },
    });
  else if (message.type === "user") {
    const content = Schema.decodeSync(
      Schema.Union([
        Schema.String,
        Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
      ]),
    )(message.message.content);

    void turn(Schema.is(Schema.String)(content) ? content : content.map((part) => part.text ?? "").join("\n"));
  }
}
