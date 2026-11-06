#!/usr/bin/env bun
/** ACP fixture with durable sessions behind disposable process homes. */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { JsonObject } from "@canopy/domain";
import { recordInput, recordProbe, releaseProbe } from "./instance-probe.ts";
import { arg, botEvidence, botFailure, botTool } from "./bot-probe.ts";

const servers = new Map<string, { url: string; headers: Record<string, string> }>();
const permissions = new Map<string, (denied: boolean) => void>();
const profile = arg("--agent-profile");
const instructions = profile ? readFileSync(profile, "utf8") : "";

function transcript(session: string, update: JsonObject) {
  const dir = join(process.env["GROK_HOME"]!, "sessions", "fixture", session);
  mkdirSync(dir, { recursive: true });
  appendFileSync(
    join(dir, "updates.jsonl"),
    JSON.stringify({ method: "session/update", params: { sessionId: session, update } }) + "\n",
  );
}

if (process.argv.includes("--version")) {
  console.log("grok 1.0.70");
  process.exit();
}

const send = (message: JsonObject) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");

recordProbe("grok", "spawn");

async function turn(
  id: number,
  params: { sessionId: string; prompt: { type: string; text?: string; mimeType?: string }[] },
): Promise<void> {
  recordProbe("grok", "turn", params.sessionId);
  recordInput(
    "grok",
    params.prompt.map((p) => ({ type: p.type, text: p.text, image: p.mimeType })),
  );
  const text = params.prompt.map((p) => p.text ?? "").join("\n");
  transcript(params.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text } });
  await releaseProbe(text);
  const failure = process.env["BOT_TRACE"] ? botFailure(text) : undefined;

  if (failure) {
    if (text.includes("FAIL:exit")) process.exit(7);
    send({ id, error: { code: -32000, message: failure.message } });

    return;
  }

  const marker = join(process.env["GROK_HOME"]!, "sessions", "failed-once");

  if (text.includes("FAIL_ONCE") && !existsSync(marker)) {
    writeFileSync(marker, "failed");
    send({ id, result: { stopReason: "max_tokens" } });

    return;
  }

  let answer: string;

  if (text.includes("BUILTIN_PERMISSION")) {
    const denied = new Promise<boolean>((resolve) => permissions.set("fixture-permission", resolve));
    send({
      id: "fixture-permission",
      method: "session/request_permission",
      params: {
        sessionId: params.sessionId,
        toolCall: { toolCallId: "local", title: "run_terminal_command", kind: "execute" },
        options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
      },
    });
    answer = (await denied) ? "BUILTIN_DENIED" : "BUILTIN_ALLOWED";
  } else answer = await botTool(text, servers.get(params.sessionId), instructions);
  transcript(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer } });
  transcript(params.sessionId, { sessionUpdate: "turn_completed", stop_reason: "end_turn" });

  if (text.includes("CRASH_AFTER_TRANSCRIPT")) process.exit(1);
  recordProbe("grok", "finish", params.sessionId);
  send({
    method: "session/update",
    params: {
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer } },
    },
  });
  send({ id, result: { stopReason: "end_turn" } });
}

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  const { id, params } = message;

  if (permissions.has(id)) {
    permissions.get(id)!(params?.outcome?.optionId !== "allow" && message.result?.outcome?.optionId !== "allow");
    permissions.delete(id);
  } else if (message.method === "initialize")
    send({
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, mcpCapabilities: { http: true }, promptCapabilities: { image: true } },
      },
    });
  else if (message.method === "session/new" || message.method === "session/load") {
    const session = params.sessionId ?? crypto.randomUUID();
    const file = join(process.env["GROK_HOME"]!, "sessions", `${session}.json`);

    // A real session directory (sessions/<encoded cwd>/<id>/, e.g. an imported one) loads too.
    const sessions = join(process.env["GROK_HOME"]!, "sessions");

    const real =
      existsSync(sessions) &&
      readdirSync(sessions).some((group) => existsSync(join(sessions, group, session, "chat_history.jsonl")));

    if (message.method === "session/load" && !existsSync(file) && !real) {
      send({ id, error: { code: -32000, message: "Session missing" } });
      continue;
    }

    writeFileSync(file, "{}");

    if (process.env["BOT_TRACE"]) {
      botEvidence("grok", arg("--tools") === "search_tool,use_tool" && !!arg("--agent-profile"));
      const server = params.mcpServers?.[0];

      if (server)
        servers.set(session, {
          url: server.url,
          headers: Object.fromEntries(server.headers.map((h: { name: string; value: string }) => [h.name, h.value])),
        });
    }

    recordProbe("grok", message.method, session);
    send({ id, result: { sessionId: session } });
  } else if (message.method === "session/prompt") void turn(id, params);
  else if (id !== undefined) send({ id, result: {} });
}
