#!/usr/bin/env bun
/** Scripted provider transport: tiers are visible at the native process boundary. */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { Match } from "effect";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { JsonObject } from "@canopy/domain";
import { decodeJsonObject, jsonObject, jsonString } from "../json.ts";

const trace = process.env["TIER_TRACE"]!;
const send = (message: JsonObject) => process.stdout.write(`${JSON.stringify(message)}\n`);
const record = (message: JsonObject) => appendFileSync(trace, `${JSON.stringify({ ...message, pid: process.pid })}\n`);

const tiers = [
  { id: "fast", name: "Fast", description: "Fast tier" },
  { id: "ultrafast", name: "Ultra fast", description: "Ultra tier" },
];

async function codex() {
  for await (const line of createInterface({ input: process.stdin })) {
    const request = decodeJsonObject(JSON.parse(line));
    const id = request["id"];

    if (id === undefined) continue;
    const params = jsonObject(request["params"]) ?? {};
    const method = jsonString(request["method"]) ?? "";
    record({ method, params });

    if (method === "initialize") {
      send({ id, result: { userAgent: "tier-fixture" } });
    } else if (method === "model/list") {
      send({
        id,
        result: {
          data: [
            {
              id: "fixture",
              model: "fixture",
              displayName: "Fixture",
              description: "",
              hidden: false,
              isDefault: true,
              supportedReasoningEfforts: [],
              defaultReasoningEffort: "medium",
              additionalSpeedTiers: ["invented"],
              serviceTiers: process.env["TIER_DISABLED"] ? [] : tiers,
            },
          ],
          nextCursor: null,
        },
      });
    } else if (["thread/start", "thread/fork", "thread/resume"].includes(method)) {
      send({
        id,
        result: {
          thread: { id: method === "thread/resume" ? (params["threadId"] ?? "") : crypto.randomUUID(), path: null },
        },
      });
    } else if (method === "mcpServerStatus/list") {
      send({
        id,
        result: { data: [{ name: "canopy_connectors", runtimeStatus: "connected", tools: {} }], nextCursor: null },
      });
    } else if (method === "turn/start") {
      const turn = { id: crypto.randomUUID(), status: "inProgress", items: [], error: null };
      send({ id, result: { turn } });
      send({ method: "turn/started", params: { threadId: params["threadId"] ?? "", turn } });

      // Keep adapter-test turns running; bot probes complete without model inference.
      if (process.env["TIER_BOT_COMPLETE"])
        send({
          method: "turn/completed",
          params: { threadId: params["threadId"] ?? "", turn: { ...turn, status: "completed" } },
        });
    } else send({ id, result: {} });
  }
}

function argument(name: string) {
  const index = process.argv.indexOf(name);

  return index >= 0
    ? process.argv[index + 1]
    : process.argv.find((v) => v.startsWith(`${name}=`))?.slice(name.length + 1);
}

async function claude() {
  const source = argument("--settings");

  const settings = source
    ? decodeJsonObject(JSON.parse(source.startsWith("{") ? source : readFileSync(source, "utf8")))
    : {};

  let fast = settings["fastMode"] === true;
  const session = argument("--resume") ?? argument("--session-id") ?? crypto.randomUUID();
  const home = process.env["CLAUDE_CONFIG_DIR"]!;
  const folder = join(home, "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(folder, { recursive: true });
  record({ method: "spawn", settings, resume: argument("--resume") ?? "", session });

  for await (const line of createInterface({ input: process.stdin })) {
    const message = decodeJsonObject(JSON.parse(line));

    if (message["type"] === "control_request") {
      const request = jsonObject(message["request"]) ?? {};
      const method = jsonString(request["subtype"]) ?? "";
      record({ method, request });

      if (method === "apply_flag_settings") fast = jsonObject(request["settings"])?.["fastMode"] === true;
      const reason = process.env["TIER_DISABLED"];

      const response = Match.value(method).pipe(
        Match.when("initialize", () => ({
          commands: [],
          agents: [],
          account: {},
          output_style: "default",
          available_output_styles: [],
          models: [
            { value: "default", displayName: "Default", description: "", supportsFastMode: true },
            { value: "small", displayName: "Small", description: "", supportsFastMode: false },
            { value: "fixture", displayName: "Fixture", description: "", supportsFastMode: true },
          ],
          fast_mode_state: fast && !reason ? "on" : "off",
          ...(reason && { fast_mode_disabled_reason: reason }),
        })),
        Match.when("mcp_set_servers", () => ({ added: [], removed: [], errors: {} })),
        Match.when("mcp_status", () => ({ mcpServers: [{ name: "canopy", status: "connected", tools: [] }] })),
        Match.orElse(() => ({})),
      );

      send({
        type: "control_response",
        response: { subtype: "success", request_id: message["request_id"] ?? "", response },
      });
    } else if (message["type"] === "user") {
      record({ method: "prompt", fast, session });

      const user = {
        type: "user",
        uuid: crypto.randomUUID(),
        sessionId: session,
        cwd: process.cwd(),
        timestamp: new Date().toISOString(),
        parentUuid: null,
        isSidechain: false,
        message: message["message"],
      };

      appendFileSync(join(folder, `${session}.jsonl`), `${JSON.stringify(user)}\n`);
      send({
        type: "system",
        subtype: "init",
        session_id: session,
        uuid: crypto.randomUUID(),
        tools: [],
        model: "fixture",
        cwd: process.cwd(),
      });
      send({
        type: "system",
        subtype: "task_started",
        session_id: session,
        uuid: crypto.randomUUID(),
        task_id: "background",
        tool_use_id: "background-tool",
        description: "Keep process alive",
        is_backgrounded: true,
        task_type: "local_bash",
      });
      send({
        type: "result",
        subtype: "success",
        session_id: session,
        uuid: crypto.randomUUID(),
        is_error: false,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        result: "Done",
        total_cost_usd: 0,
        usage: {},
        modelUsage: {},
        permission_denials: [],
        stop_reason: "end_turn",
      });
    }
  }
}

if (process.argv.includes("debug")) console.log(JSON.stringify({ models: [] }));
else if (process.argv.includes("--codex") || process.argv.includes("app-server")) await codex();
else await claude();
