#!/usr/bin/env bun
/** Codex wire fixture with real durable session files and independently releasable turns. */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { JsonObject } from "@canopy/domain";
import { recordInput, recordProbe, releaseProbe } from "./instance-probe.ts";
import { botFailure, botTool, codexBotConfig } from "./bot-probe.ts";
import { decodeJsonObject, jsonObject } from "../../../apps/worker/src/providers/json.ts";

if (process.argv.includes("--version")) {
  console.log("codex-cli 0.164.0");
  process.exit();
}

if (process.argv[2] === "debug" && process.argv[3] === "models") {
  // The raw catalog entry carries local tools; the bot catalog must keep only its limits.
  const entry = {
    slug: "fixture-model",
    context_window: 64_000,
    auto_compact_token_limit: 48_000,
    truncation_policy: { mode: "tokens", limit: 12_000 },
    shell_type: "unified_exec",
    tool_mode: "code_mode_only",
    experimental_supported_tools: ["clock"],
  };

  console.log(JSON.stringify({ models: [entry] }));
  process.exit();
}

const home = process.env["CODEX_HOME"]!;

mkdirSync(join(home, "sessions"), { recursive: true });

recordProbe("codex", "spawn");

const providers = new Map<string, string>();

// App-server checks both routes at turn admission, beyond accepting modelProvider on start/resume.
const currentProvider =
  process.argv.flatMap((arg) => /^model_provider="([a-z0-9_-]+)"$/.exec(arg)?.[1] ?? []).at(-1) ?? "openai";

const botServers = new Map<string, ReturnType<typeof codexBotConfig>>();
const instructions = new Map<string, string>();
const interrupted = new Set<string>();
const send = (message: JsonObject) => process.stdout.write(JSON.stringify(message) + "\n");
const notify = (method: string, params: JsonObject) => send({ method, params });

async function turn(
  id: number,
  params: { threadId: string; input: { type: string; text?: string; path?: string }[] },
): Promise<void> {
  recordInput(
    "codex",
    params.input.map((i) => ({ type: i.type, text: i.text, image: i.path?.split("/").pop() })),
  );
  const turnId = crypto.randomUUID();
  const threadId = params.threadId;
  const text = params.input.map((i) => i.text ?? "").join("\n");

  if (providers.get(threadId) !== currentProvider || text === "FAIL:provider-switch") {
    send({
      id,
      error: {
        code: -32600,
        message: `This chat uses ${providers.get(threadId)}, but your current provider is ${text === "FAIL:provider-switch" ? "other" : currentProvider}. Switch to ${providers.get(threadId)} to continue.`,
      },
    });

    return;
  }

  send({ id, result: { turn: { id: turnId, status: "inProgress", items: [], error: null } } });
  notify("turn/started", { threadId, turn: { id: turnId, status: "inProgress", items: [], error: null } });
  recordProbe("codex", "turn", threadId, providers.get(threadId));
  await releaseProbe(text);

  if (interrupted.delete(turnId)) return;
  const failure = process.env["BOT_TRACE"] ? botFailure(text) : undefined;

  if (failure) {
    if (text.includes("FAIL:exit")) process.exit(7);
    notify("turn/completed", {
      threadId,
      turn: {
        id: turnId,
        status: "failed",
        items: [],
        error: { message: failure.message, codexErrorInfo: failure.codex, additionalDetails: null },
      },
    });

    return;
  }

  const failureMarker = join(home, "bot-failed-once");

  if (process.env["BOT_TRACE"] && text.includes("FAIL_ONCE") && !existsSync(failureMarker)) {
    writeFileSync(failureMarker, "failed");
    notify("turn/completed", {
      threadId,
      turn: {
        id: turnId,
        status: "failed",
        items: [],
        error: { message: "fixture failure", codexErrorInfo: "usageLimitExceeded", additionalDetails: null },
      },
    });

    return;
  }

  if (process.env["BOT_TRACE"] || text.startsWith("[canopy] Owner shell command result")) {
    if (process.env["BOT_TRACE"]) writeFileSync(join(home, "bot-input.txt"), text);
    const answer = await botTool(text, botServers.get(threadId), instructions.get(threadId));
    notify("item/completed", {
      threadId,
      turnId,
      item: { id: `answer-${turnId}`, type: "agentMessage", text: answer },
    });
  }

  recordProbe("codex", "finish", threadId, providers.get(threadId));

  if (text.includes("BACKGROUND")) {
    const command = {
      type: "commandExecution",
      id: `exec-${turnId}`,
      command: "fixture background",
      cwd: process.cwd(),
      processId: turnId,
      source: "unifiedExecStartup",
      status: "inProgress",
      commandActions: [],
      aggregatedOutput: "",
      exitCode: null,
      durationMs: null,
    };

    notify("item/started", { threadId, turnId, item: command });
    notify("turn/completed", { threadId, turn: { id: turnId, status: "completed", items: [], error: null } });
    await releaseProbe("HOLD:background");
    notify("item/completed", { threadId, turnId, item: { ...command, status: "completed", exitCode: 0 } });
  } else notify("turn/completed", { threadId, turn: { id: turnId, status: "completed", items: [], error: null } });
}

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);

  if (request.id === undefined) continue;
  const { id, params } = request;

  if (request.method === "initialize") send({ id, result: { userAgent: "instance-fixture" } });
  else if (request.method === "model/list") send({ id, result: { data: [], nextCursor: null } });
  else if (request.method === "thread/start" || request.method === "thread/resume") {
    const session = params.threadId ?? crypto.randomUUID();
    const file = join(home, "sessions", `${session}.json`);

    // A real rollout (sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl, e.g. an imported one) resumes too.
    const rollout = readdirSync(join(home, "sessions"), { recursive: true })
      .map(String)
      .find((p) => p.endsWith(`-${session}.jsonl`));

    if (request.method === "thread/resume" && !existsSync(file) && !rollout) {
      send({ id, error: { code: -32000, message: "Session missing from CODEX_HOME" } });
      continue;
    }

    if (request.method === "thread/resume" && rollout) {
      const meta = decodeJsonObject(JSON.parse(readFileSync(join(home, "sessions", rollout), "utf8").split("\n")[0]!));
      const saved = jsonObject(meta["payload"])?.["model_provider"];

      // Codex 0.166 validates the saved route before applying modelProvider, even on cold resume.
      if (saved !== currentProvider || existsSync(join(home, "refuse-import-resume"))) {
        send({
          id,
          error: {
            code: -32600,
            message: `This chat uses model provider "${saved}", which is no longer configured. Restore this provider's configuration to continue.`,
          },
        });
        continue;
      }
    }

    writeFileSync(file, "{}");
    providers.set(session, params.modelProvider);
    instructions.set(session, params.baseInstructions ?? "");

    if (params.config) botServers.set(session, codexBotConfig(params.config));
    recordProbe("codex", request.method, session, params.modelProvider);
    send({ id, result: { thread: { id: session, path: null } } });
  } else if (request.method === "turn/start") void turn(id, params);
  else if (request.method === "turn/interrupt") {
    interrupted.add(params.turnId);
    send({ id, result: {} });
    notify("turn/completed", {
      threadId: params.threadId,
      turn: { id: params.turnId, status: "interrupted", items: [], error: null },
    });
  } else if (request.method === "turn/steer") {
    const text = params.input.map((part: { text?: string }) => part.text ?? "").join("\n");
    send({ id, result: { turnId: params.expectedTurnId } });
    notify("item/completed", {
      threadId: params.threadId,
      turnId: params.expectedTurnId,
      item: {
        id: crypto.randomUUID(),
        type: "userMessage",
        content: [{ type: "text", text, text_elements: [] }],
        clientId: params.clientUserMessageId,
      },
    });
  } else send({ id, result: {} });
}
