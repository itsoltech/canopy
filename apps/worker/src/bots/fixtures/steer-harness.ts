#!/usr/bin/env bun
/** Controlled native transports: RPC/stream admission and actual user consumption are independent. */
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type { JsonObject } from "@canopy/domain";
import { decodeJsonObject, jsonObject, jsonString } from "../../providers/json.ts";

if (process.argv[2] === "debug") {
  console.log('{"models":[]}');
  process.exit();
}

const trace = process.env["STEER_TRACE"]!;
const claude = process.argv.includes("--output-format");
const session = crypto.randomUUID();
const nativeTurn = crypto.randomUUID();
const send = (value: JsonObject) => process.stdout.write(`${JSON.stringify(value)}\n`);
const notify = (method: string, params: JsonObject) => send({ method, params });
const turn = (status: string) => ({ id: nativeTurn, status, items: [], error: null });
let initial = true;

function textOf(value: JsonObject): string {
  const content = value["input"] ?? jsonObject(value["message"])?.["content"];

  return Array.isArray(content)
    ? content.map((part) => jsonString(jsonObject(part)?.["text"]) ?? "").join("\n")
    : (jsonString(content) ?? "");
}

function finish() {
  if (claude)
    send({ type: "result", subtype: "success", result: "DONE", is_error: false, session_id: session, usage: {} });
  else notify("turn/completed", { threadId: session, turn: turn("completed") });
}

function consume(id: string, text: string) {
  if (text === "CRASH") process.exit(8);

  if (text === "REJECT") {
    send({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["fixture rejected queued input"],
      session_id: session,
      user_message_uuid: id,
      usage: {},
    });

    return;
  }

  if (text === "DROP") {
    finish();

    if (claude) setTimeout(() => process.exit(0), 10);

    return;
  }

  if (claude)
    send({
      type: "command_lifecycle",
      command_uuid: id,
      state: "started",
      session_id: session,
    });
  else {
    const item = {
      type: "userMessage",
      id: crypto.randomUUID(),
      clientId: id,
      content: [{ type: "text", text, text_elements: [] }],
    };

    // None of these foreign echoes may settle this turn's input.
    notify("item/started", { threadId: crypto.randomUUID(), turnId: nativeTurn, item });
    notify("item/started", { threadId: session, turnId: crypto.randomUUID(), item });

    if (text === "FOREIGN_ECHO") return;
    notify("item/started", { threadId: session, turnId: nativeTurn, item });
    notify("item/completed", { threadId: session, turnId: nativeTurn, item });
  }
}

for await (const line of createInterface({ input: process.stdin })) {
  const request = decodeJsonObject(JSON.parse(line));
  const params = jsonObject(request["params"]) ?? {};
  const id = request["id"];
  const method = jsonString(request["method"]) ?? "";

  if (claude) {
    if (request["type"] === "control_request") {
      send({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: request["request_id"]!,
          response: { commands: [], models: [], agents: [] },
        },
      });
    } else if (request["type"] === "user") {
      const text = textOf(request);
      appendFileSync(trace, `${JSON.stringify({ method: "user", id: request["uuid"] ?? "", text })}\n`);

      if (initial) {
        initial = false;
        send({ type: "system", subtype: "init", session_id: session, uuid: crypto.randomUUID(), tools: [] });
      } else {
        send({
          type: "user",
          uuid: request["uuid"]!,
          session_id: session,
          parent_tool_use_id: null,
          isReplay: true,
          message: { role: "user", content: text },
        });
        consume(jsonString(request["uuid"])!, text);
      }
    }

    continue;
  }

  if (id === undefined) continue;
  let result: JsonObject = {};

  if (method === "initialize") result = { userAgent: "steer-fixture" };
  else if (method === "thread/start" || method === "thread/resume") result = { thread: { id: session, path: null } };
  else if (method === "turn/start") {
    result = { turn: turn("inProgress") };
    appendFileSync(trace, `${JSON.stringify({ method, text: textOf(params) })}\n`);
  } else if (method === "turn/steer") {
    const text = textOf(params);
    appendFileSync(
      trace,
      `${JSON.stringify({
        method,
        id: params["clientUserMessageId"],
        text,
        threadId: params["threadId"],
        turnId: params["expectedTurnId"],
      })}\n`,
    );
    send({ id, result: { turnId: nativeTurn } });
    consume(jsonString(params["clientUserMessageId"])!, text);

    continue;
  }

  send({ id, result });

  if (method === "turn/start") notify("turn/started", { threadId: session, turn: turn("inProgress") });
}
