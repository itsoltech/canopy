#!/usr/bin/env bun
/** Codex wire fixture with real durable session files and independently releasable turns. */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { isAgentBusTool, type JsonObject } from "@canopy/domain";
import { isMemoryTool } from "@canopy/domain/memory-tools";
import { recordInput, recordProbe, releaseProbe } from "./instance-probe.ts";
import { botFailure, botTool, codexBotConfig } from "./bot-probe.ts";
import { decodeJsonObject, jsonObject } from "../../../apps/worker/src/providers/json.ts";
import { HttpMcp, httpTools } from "./instance-mcp.ts";
import { Schema } from "effect";
import { turnError } from "../../../apps/worker/src/providers/codex/fixtures/provider-errors.ts";
import { codexLimits, usageProbe } from "./provider-usage.ts";
import { instanceCodexLogin } from "./instance-codex-login.ts";

let usagePercent = 20;
const quotaFixture = process.env["CODEX_QUOTA_FIXTURE"] === "1";

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
const ephemeral = new Set<string>();

// App-server checks both routes at turn admission, beyond accepting modelProvider on start/resume.
const currentProvider =
  process.argv.flatMap((arg) => /^model_provider="([a-z0-9_-]+)"$/.exec(arg)?.[1] ?? []).at(-1) ?? "openai";

const ephemeralAuth = process.argv.includes('cli_auth_credentials_store="ephemeral"');

const botServers = new Map<string, ReturnType<typeof codexBotConfig>>();
const instructions = new Map<string, string>();
const catalogs = new Map<string, string[]>();
const workspaces = new Map<string, { cwd: string; server: typeof HttpMcp.Type | undefined }>();
const interrupted = new Set<string>();
const send = (message: JsonObject) => process.stdout.write(JSON.stringify(message) + "\n");
const notify = (method: string, params: JsonObject) => send({ method, params });
const login = instanceCodexLogin(home, send);

async function turn(
  id: number,
  params: {
    threadId: string;
    cwd?: string;
    approvalPolicy?: string;
    sandboxPolicy?: { type: string };
    input: { type: string; text?: string; path?: string }[];
  },
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

  if (login && !(await login.authorizeTurn(text))) {
    send({ id, error: { code: -32000, message: "Missing matching isolated login" } });

    return;
  }

  send({ id, result: { turn: { id: turnId, status: "inProgress", items: [], error: null } } });
  notify("turn/started", { threadId, turn: { id: turnId, status: "inProgress", items: [], error: null } });

  const limitText = usageProbe(text);

  if (limitText) {
    usagePercent = limitText === "LIMIT:reached" ? 100 : 92;

    if (limitText === "LIMIT:read") usagePercent = 75;
    else notify("account/rateLimits/updated", { rateLimits: codexLimits(usagePercent) });

    if (limitText === "LIMIT:reached") {
      notify("turn/completed", {
        threadId,
        turn: {
          id: turnId,
          status: "failed",
          items: [],
          error: {
            message: "Weekly usage limit reached",
            codexErrorInfo: "usageLimitExceeded",
            additionalDetails: null,
          },
        },
      });

      return;
    }
  }

  recordProbe("codex", "turn", threadId, providers.get(threadId), catalogs.get(threadId));

  if (text.split("\n\nCurrent input:\n").at(-1)?.includes("STOP_REPLY"))
    notify("item/agentMessage/delta", { threadId, turnId, itemId: `answer-${turnId}`, delta: "Partial reply" });
  await releaseProbe(text);

  if (interrupted.delete(turnId)) return;
  const generated = process.env["FIXTURE_GENERATION_RESPONSE"];

  if (generated && ephemeral.has(threadId)) {
    notify("item/completed", {
      threadId,
      turnId,
      item: { id: `answer-${turnId}`, type: "agentMessage", text: generated },
    });
    notify("turn/completed", { threadId, turn: { id: turnId, status: "completed", items: [], error: null } });

    return;
  }

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
    const server = botServers.get(threadId);

    // Codex defaults unannotated MCP tools to Auto: they need approval, which Never refuses.
    if (
      (text.includes("TOOL:") && server?.default_tools_approval_mode !== "approve") ||
      text.includes("FAIL:MCP_POLICY")
    ) {
      notify("item/completed", {
        threadId,
        turnId,
        item: {
          id: `tool-${turnId}`,
          type: "mcpToolCall",
          server: "canopy",
          tool: "create_bot",
          status: "failed",
          arguments: {},
          result: null,
          error: { message: "MCP tool call requires approval, but approval policy is never" },
        },
      });
      notify("turn/completed", { threadId, turn: { id: turnId, status: "completed", items: [], error: null } });

      return;
    }

    const answer = await botTool(text, botServers.get(threadId), instructions.get(threadId));

    if (!text.split("\n\nCurrent input:\n").at(-1)?.includes("FIXTURE_SILENT_AFTER_TOOL"))
      notify("item/completed", {
        threadId,
        turnId,
        item: { id: `answer-${turnId}`, type: "agentMessage", text: answer },
      });
  } else if (text.includes("TOOL:switch_worktree") || text.includes("REPORT_THREAD_CWD")) {
    const workspace = workspaces.get(threadId);

    const answer = text.includes("TOOL:switch_worktree")
      ? await botTool(text, workspace?.server)
      : JSON.stringify({
          cwd: params.cwd ?? workspace?.cwd,
          approval: params.approvalPolicy,
          sandbox: params.sandboxPolicy?.type,
        });

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
  } else {
    if (text.includes("HOLD:provider-warnings"))
      notify("item/completed", {
        threadId,
        turnId,
        item: { id: `answer-${turnId}`, type: "agentMessage", text: "Finished successfully", phase: "final_answer" },
      });
    notify("turn/completed", { threadId, turn: { id: turnId, status: "completed", items: [], error: null } });
  }
}

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);

  if (request.id === undefined) continue;
  const { id, params } = request;

  if (login?.handle(id, request.method, request.result ?? params ?? {})) continue;

  if (request.method === "initialize") send({ id, result: { userAgent: "instance-fixture" } });
  else if (request.method === "account/read" && quotaFixture)
    send({ id, result: { account: { type: "chatgpt", email: "codex@example.test", planType: "plus" } } });
  else if (request.method === "config/read")
    send({
      id,
      result: {
        config: { model_provider: currentProvider, ...(ephemeralAuth && { cli_auth_credentials_store: "ephemeral" }) },
        origins: {},
        layers: null,
      },
    });
  else if (request.method === "configRequirements/read") send({ id, result: { requirements: null } });
  else if (request.method === "account/rateLimits/read") {
    const rateLimits = codexLimits(usagePercent);

    send({
      id,
      result: {
        rateLimits,
        rateLimitsByLimitId: quotaFixture
          ? {
              codex: {
                ...rateLimits,
                secondary: {
                  usedPercent: usagePercent,
                  windowDurationMins: 10080,
                  resetsAt: Math.floor(Date.now() / 1000) + 3600,
                },
              },
            }
          : null,
        ordinaryUsageAllowed: quotaFixture ? usagePercent < 100 : null,
        accountId: quotaFixture ? "fixture-workspace" : null,
        rateLimitResetCredits: null,
      },
    });
  } else if (request.method === "model/list") send({ id, result: { data: [], nextCursor: null } });
  else if (["thread/start", "thread/resume", "thread/fork"].includes(request.method)) {
    const session = request.method === "thread/resume" ? params.threadId : crypto.randomUUID();
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

    if (params.ephemeral) ephemeral.add(session);
    instructions.set(session, params.baseInstructions ?? "");

    if (params.config) botServers.set(session, codexBotConfig(params.config));

    const config = Schema.decodeUnknownSync(
      Schema.Struct({ mcp_servers: Schema.optionalKey(Schema.Record(Schema.String, HttpMcp)) }),
    )(params.config ?? {});

    const server = config.mcp_servers?.["canopy_connectors"];
    workspaces.set(session, { cwd: params.cwd, server });
    catalogs.set(session, await httpTools(server));
    recordProbe("codex", request.method, session, params.modelProvider);
    send({ id, result: { thread: { id: session, path: null } } });
  } else if (request.method === "mcpServerStatus/list") {
    const attachFailed =
      process.env["PROFILE_PROBE"] === "connector-failure" &&
      !existsSync(join(dirname(process.env["INSTANCE_TRACE"]!), "release-attach"));

    const names = catalogs.get(params.threadId) ?? [];
    // The external connector is missing, but the platform's built-in tools still attach.
    const attached = attachFailed ? names.filter((name) => isMemoryTool(name) || isAgentBusTool(name)) : names;

    send({
      id,
      result: {
        data: [
          {
            name: "canopy_connectors",
            runtimeStatus: "connected",
            toolsError: null,
            tools: Object.fromEntries(attached.map((name) => [name, { name }])),
          },
        ],
        nextCursor: null,
      },
    });
  } else if (request.method === "turn/start") void turn(id, params);
  else if (request.method === "turn/interrupt") {
    recordProbe("codex", "turn/interrupt", params.threadId);
    interrupted.add(params.turnId);
    send({ id, result: {} });
    notify("turn/completed", {
      threadId: params.threadId,
      turn: { id: params.turnId, status: "interrupted", items: [], error: null },
    });
  } else if (request.method === "turn/steer") {
    recordProbe("codex", "turn/steer", params.threadId);

    if (process.env["PROFILE_PROBE"] === "provider-warnings")
      for (let attempt = 0; attempt < 3; attempt++)
        notify("error", {
          threadId: params.threadId,
          turnId: "",
          willRetry: false,
          error: decodeJsonObject(turnError),
        });
    recordInput(
      "codex",
      params.input.map((i: { type: string; text?: string; path?: string }) => ({
        type: i.type,
        text: i.text,
        image: i.path?.split("/").pop(),
      })),
    );
    const text = params.input.map((part: { text?: string }) => part.text ?? "").join("\n");
    send({ id, result: { turnId: params.expectedTurnId } });

    if (text.endsWith("FIXTURE_UNCONFIRMED_BOT_STEER")) continue;
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
