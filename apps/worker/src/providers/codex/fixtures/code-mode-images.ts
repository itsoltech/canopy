/** Scripted app-server with several outputs in a single rollout read; no inference. */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type { JsonObject } from "@canopy/domain";
import { decodeJsonObject, jsonObject } from "../../json.ts";

const rollout = process.env["CANOPY_TEST_ROLLOUT"]!;
const image = readFileSync(process.env["CANOPY_TEST_IMAGE"]!).toString("base64");
const nextImage = readFileSync(process.env["CANOPY_TEST_SECOND_IMAGE"]!).toString("base64");
const send = (value: JsonObject) => process.stdout.write(`${JSON.stringify(value)}\n`);
const turn = (status: string) => ({ id: "image-turn", status, items: [], error: null });
const record = (type: string, payload: JsonObject) => appendFileSync(rollout, `${JSON.stringify({ type, payload })}\n`);

for await (const line of createInterface({ input: process.stdin })) {
  const request = decodeJsonObject(JSON.parse(line));
  const id = request["id"];

  if (id === undefined) continue;
  const params = jsonObject(request["params"]) ?? {};

  switch (request["method"]) {
    case "initialize":
      send({ id, result: { userAgent: "image-fixture" } });
      break;
    case "thread/start":
      writeFileSync(rollout, "");
      send({ id, result: { thread: { id: "image-thread", path: rollout } } });
      break;
    case "model/list":
      send({ id, result: { data: [], nextCursor: null } });
      break;
    case "mcpServerStatus/list":
      send({
        id,
        result: { data: [{ name: "canopy_connectors", runtimeStatus: "connected", tools: {} }], nextCursor: null },
      });
      break;
    case "turn/start": {
      const threadId = params["threadId"]!;
      send({ id, result: { turn: turn("inProgress") } });
      send({ method: "turn/started", params: { threadId, turn: turn("inProgress") } });
      record("turn_context", { turn_id: "image-turn" });
      record("response_item", { type: "custom_tool_call", call_id: "cell", name: "exec", input: "image(result)" });
      record("response_item", {
        type: "custom_tool_call_output",
        call_id: "cell",
        id: "provider-output-id",
        audit: { source: "fixture", ordinal: 1 },
        output: [
          { type: "input_text", text: "before\n" },
          { type: "input_image", image_url: `data:image/png;base64,${image}`, detail: "original", label: "capture" },
          { type: "input_image", image_url: `data:image/png;base64,${image}`, detail: "low" },
          { type: "input_text", text: "after\n" },
        ],
      });
      record("response_item", {
        type: "custom_tool_call_output",
        call_id: "cell",
        output: [
          { type: "input_text", text: "next image" },
          { type: "input_image", image_url: `data:image/png;base64,${nextImage}` },
        ],
      });
      record("response_item", { type: "custom_tool_call_output", call_id: "cell", output: "finished\n" });
      record("response_item", { type: "function_call", call_id: "wait-cell", name: "wait", arguments: "{}" });
      record("response_item", {
        type: "function_call_output",
        call_id: "wait-cell",
        output: [{ type: "input_image", image_url: `data:image/png;base64,${image}` }],
      });
      record("event_msg", { type: "task_complete", turn_id: "image-turn" });
      send({
        method: "thread/readState/changed",
        params: {
          threadId,
          turnId: "image-turn",
          probe: { type: "input_image", image_url: `data:image/png;base64,${nextImage}` },
        },
      });
      send({ method: "turn/completed", params: { threadId, turn: turn("completed") } });
      break;
    }

    default:
      send({ id, result: {} });
  }
}
