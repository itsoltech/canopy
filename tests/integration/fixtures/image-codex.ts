#!/usr/bin/env bun
/** Offline app-server peer for image publication through the complete WorkerHost. */
import { createInterface } from "node:readline";
import type { JsonObject } from "@canopy/domain";
import { decodeJsonObject, jsonObject, jsonString } from "../../../apps/worker/src/providers/json.ts";

if (process.argv[2] === "--version") {
  console.log("codex-cli 0.170.0");
  process.exit(0);
}

const send = (value: JsonObject) => process.stdout.write(`${JSON.stringify(value)}\n`);
const notify = (method: string, params: JsonObject) => send({ method, params });
let active = { threadId: "", turnId: "", text: "" };

function answer() {
  const { threadId, turnId, text } = active;
  notify("item/started", {
    threadId,
    turnId,
    item: { type: "agentMessage", id: "reply", text: "", phase: "final_answer" },
  });

  // One-character boundaries exercise split image markers. Completion deliberately omits the snapshot.
  for (const delta of text) notify("item/agentMessage/delta", { threadId, turnId, itemId: "reply", delta });
  notify("item/completed", {
    threadId,
    turnId,
    item: { type: "agentMessage", id: "reply", text: "", phase: "final_answer" },
  });
  notify("turn/completed", { threadId, turn: { id: turnId, status: "completed", items: [], error: null } });
}

for await (const line of createInterface({ input: process.stdin })) {
  const request = decodeJsonObject(JSON.parse(line));
  const id = request["id"];
  const method = request["method"];
  const params = jsonObject(request["params"]) ?? {};

  if (id === undefined) continue;

  if (method === "initialize") send({ id, result: { userAgent: "image-fixture" } });
  else if (method === "model/list") send({ id, result: { data: [], nextCursor: null } });
  else if (method === "thread/start" || method === "thread/fork")
    send({ id, result: { thread: { id: crypto.randomUUID(), path: null } } });
  else if (method === "turn/start") {
    const input = params["input"];
    const text = Array.isArray(input) ? (jsonString(jsonObject(input[0])?.["text"]) ?? "") : "";
    const data = decodeJsonObject(JSON.parse(text));
    active = {
      threadId: jsonString(params["threadId"]) ?? "",
      turnId: crypto.randomUUID(),
      text: jsonString(data["text"]) ?? "",
    };
    send({ id, result: { turn: { id: active.turnId, status: "inProgress", items: [], error: null } } });
    notify("turn/started", {
      threadId: active.threadId,
      turn: { id: active.turnId, status: "inProgress", items: [], error: null },
    });

    if (data["show"] === true)
      send({
        id: "show-images",
        method: "item/tool/call",
        params: {
          threadId: active.threadId,
          turnId: active.turnId,
          callId: "show-images",
          namespace: "canopy",
          tool: "show_images",
          arguments: { images: [{ path: "screen.png", alt: "Published by the worker" }] },
        },
      });
    else answer();
  } else if (id === "show-images") answer();
  else send({ id, result: {} });
}
