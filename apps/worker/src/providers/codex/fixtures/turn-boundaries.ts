/** Scripted app-server: native wake-ups and old model events race turn/start's response. */
import { createInterface } from "node:readline";
import type { JsonObject } from "@canopy/domain";
import { decodeJsonObject, jsonObject, jsonString } from "../../json.ts";

const send = (message: JsonObject) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method: string, params: JsonObject) => send({ method, params });
let ordinal = 0;
let previous = "";
let instructions = "";

function turn(id: string, status = "inProgress"): JsonObject {
  return { id, status, items: [], error: null };
}

function message(threadId: string, turnId: string, text: string) {
  notify("item/completed", {
    threadId,
    turnId,
    item: { id: `answer-${turnId}`, type: "agentMessage", text, phase: "final_answer" },
  });
}

async function start(id: JsonObject[string], params: JsonObject) {
  const threadId = jsonString(params["threadId"])!;
  const parts = params["input"];
  const text = Array.isArray(parts) ? parts.map((p) => jsonString(jsonObject(p)?.["text"]) ?? "").join("\n") : "";
  const turnId = `requested-${++ordinal}`;
  const early = text.startsWith("WAKE:") || text === "FAIL_START";

  if (early) {
    const wakeId = `wake-${ordinal}`;
    notify("turn/started", { threadId, turn: turn(wakeId) });
    message(threadId, wakeId, "Landing page rebuilt (background report)");
    notify("turn/completed", { threadId, turn: turn(wakeId, "completed") });
    // Force notification handling before the response, independently of process scheduling.
    await Bun.sleep(30);
  }

  if (text === "FAIL_START") {
    send({ id, error: { code: -32600, message: "fixture rejected admission" } });

    return;
  }

  if (!early) send({ id, result: { turn: turn(turnId) } });
  notify("turn/started", { threadId, turn: turn(turnId) });

  if (early) {
    await Bun.sleep(30);
    send({ id, result: { turn: turn(turnId) } });
  }

  if (previous) {
    message(threadId, previous, "Late summary from the previous turn");
    notify("turn/completed", { threadId, turn: turn(previous, "completed") });
  }

  notify("item/completed", {
    threadId,
    turnId,
    item: {
      id: `input-${turnId}`,
      type: "userMessage",
      clientId: jsonString(params["clientUserMessageId"]) ?? "",
      content: [{ type: "text", text, text_elements: [] }],
    },
  });
  message(threadId, turnId, instructions ? `Context: ${instructions}` : `Echo: ${text}`);

  if (!previous)
    notify("item/started", {
      threadId,
      turnId,
      item: {
        id: "background-command",
        type: "commandExecution",
        command: "background process",
        cwd: "/repo",
        processId: "background-process",
        source: "unifiedExecStartup",
        status: "inProgress",
        commandActions: [],
        aggregatedOutput: "",
        exitCode: null,
        durationMs: null,
      },
    });
  notify("turn/completed", { threadId, turn: turn(turnId, "completed") });

  if (previous)
    notify("item/commandExecution/outputDelta", {
      threadId,
      turnId: previous,
      itemId: "background-command",
      delta: "still running",
    });
  previous = turnId;
}

for await (const line of createInterface({ input: process.stdin })) {
  const request = decodeJsonObject(JSON.parse(line));
  const id = request["id"];

  if (id === undefined) continue;
  const params = jsonObject(request["params"]) ?? {};

  switch (request["method"]) {
    case "initialize":
      send({ id, result: { userAgent: "turn-boundary-fixture" } });
      break;
    case "thread/start":
      instructions = jsonString(params["developerInstructions"]) ?? "";
      send({ id, result: { thread: { id: "fixture-thread", path: null } } });
      break;
    case "thread/resume":
      if (params["threadId"] === "missing-rollout") send({ id, error: { code: -32600, message: "no rollout found" } });
      else send({ id, result: { thread: { id: "fixture-thread", path: null } } });
      break;
    case "model/list":
      send({ id, result: { data: [], nextCursor: null } });
      break;
    case "turn/start":
      void start(id, params);
      break;
    default:
      send({ id, result: {} });
  }
}
