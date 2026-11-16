import { appendFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { JsonObject } from "@canopy/domain";
import { decodeJsonObject, jsonObject, jsonString } from "../../json.ts";

const root = process.env["RELEASE_ROOT"]!;
const send = (value: JsonObject) => process.stdout.write(`${JSON.stringify(value)}\n`);
const notify = (method: string, params: JsonObject) => send({ method, params });
const turn = (id: string, status = "inProgress") => ({ id, status, items: [], error: null });
const sessions = new Map<string, string>();
const goals = new Map<string, string>();
let ordinal = 0;

for await (const line of createInterface({ input: process.stdin })) {
  const request = decodeJsonObject(JSON.parse(line));
  const id = request["id"];

  if (id === undefined) continue;
  const method = jsonString(request["method"])!;
  const params = jsonObject(request["params"]) ?? {};
  let threadId = jsonString(params["threadId"]) ?? "";
  const mcp = jsonObject(jsonObject(params["config"])?.["mcp_servers"]);
  const url = jsonString(jsonObject(mcp?.["canopy_connectors"])?.["url"]) ?? "";
  appendFileSync(
    join(root, "trace.jsonl"),
    `${JSON.stringify({ method, threadId, url, goalStatus: goals.get(threadId) ?? "", pid: process.pid })}\n`,
  );
  let result: JsonObject = {};

  if (method === "initialize") result = { userAgent: "release-fixture" };
  else if (method === "thread/start" || method === "thread/resume" || method === "thread/unarchive") {
    threadId ||= crypto.randomUUID();
    const path = join(root, "sessions", `${threadId}.jsonl`);
    const archived = join(root, "archived", `${threadId}.jsonl`);
    mkdirSync(join(root, "sessions"), { recursive: true });

    if (method === "thread/unarchive" && existsSync(archived)) renameSync(archived, path);

    if (method === "thread/start") {
      await Bun.write(path, "");
      goals.set(threadId, "active");
    }

    sessions.set(threadId, path);
    result = { thread: { id: threadId, path: null } };
  } else if (method === "thread/goal/get") result = { goal: { status: goals.get(threadId) ?? "paused" } };
  else if (method === "thread/goal/set") goals.set(threadId, jsonString(params["status"]) ?? "active");
  else if (method === "thread/archive") {
    mkdirSync(join(root, "archived"), { recursive: true });
    renameSync(sessions.get(threadId)!, join(root, "archived", `${threadId}.jsonl`));
  } else if (method === "model/list") result = { data: [], nextCursor: null };
  else if (method === "mcpServerStatus/list")
    result = { data: [{ name: "canopy_connectors", runtimeStatus: "connected", tools: {} }], nextCursor: null };
  else if (method === "turn/start") {
    const turnId = `turn-${++ordinal}`;
    send({ id, result: { turn: turn(turnId) } });
    notify("turn/started", { threadId, turn: turn(turnId) });
    const input = params["input"];
    const text = Array.isArray(input) ? jsonString(jsonObject(input[0])?.["text"]) : "";

    if (text === "BACKGROUND") {
      notify("item/started", {
        threadId,
        turnId,
        item: {
          id: "command",
          type: "commandExecution",
          command: "background",
          cwd: root,
          processId: "process",
          source: "unifiedExecStartup",
          status: "inProgress",
          commandActions: [],
          aggregatedOutput: "",
          exitCode: null,
          durationMs: null,
        },
      });
      notify("turn/completed", { threadId, turn: turn(turnId, "completed") });
    }

    continue;
  }

  if (method === "turn/interrupt" && process.env["RELEASE_FAIL_INTERRUPT"])
    send({ id, error: { code: -32600, message: "fixture interrupt refused" } });
  else send({ id, result });
}
