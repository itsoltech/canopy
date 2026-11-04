#!/usr/bin/env bun
/** Isolated GenerateText ACP fixture; records only synthetic test configuration and process ownership. */
import { appendFileSync, existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { JsonObject } from "@canopy/domain";

if (process.argv.includes("--version")) {
  console.log("grok 1.0.70 (fake)");
  process.exit();
}

if (process.argv.includes("--descendant")) {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}

const home = process.env["GROK_HOME"]!;

const record = (event: JsonObject) => {
  const trace = process.env["GROK_TEXT_TRACE"];

  if (trace) appendFileSync(trace, JSON.stringify({ pid: process.pid, home, ...event }) + "\n");
};

record({ event: "spawn", authPath: process.env["GROK_AUTH_PATH"] ?? "", cwd: process.cwd() });

const send = (value: JsonObject) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");

const update = (sessionId: string, kind: string, text: string) =>
  send({
    method: "session/update",
    params: { sessionId, update: { sessionUpdate: kind, content: { type: "text", text } } },
  });

let promptId = 0;
let sessionId = "";
let pendingPermissions = 0;

for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);

  if (m.method === "initialize") {
    record({ event: "initialize", capabilities: m.params.clientCapabilities });

    if (process.env["GROK_TEXT_HANG_INIT"]) continue;
    send({
      id: m.id,
      result: {
        protocolVersion: 1,
        _meta: {
          modelState: {
            currentModelId: "grok-4.6",
            availableModels: [
              { modelId: "grok-4.6", name: "Grok" },
              { modelId: "grok-4.7-fast", name: "Grok Fast" },
              { modelId: "grok-3-mini", name: "Grok Mini" },
            ],
          },
        },
      },
    });
  } else if (m.method === "session/new") {
    sessionId = crypto.randomUUID();
    record({
      event: "session",
      sessionId,
      params: m.params,
      config: readFileSync(join(home, "config.toml"), "utf8"),
      args: process.argv.slice(2),
      skills: existsSync(join(home, "skills")),
      durableSessions: existsSync(join(home, "sessions")) && lstatSync(join(home, "sessions")).isSymbolicLink(),
    });
    await Bun.write(join(home, "sessions", sessionId + ".json"), "{}");
    send({ id: m.id, result: { sessionId } });
  } else if (m.method === "session/prompt") {
    promptId = m.id;
    const text = m.params.prompt[0].text;
    record({ event: "prompt", prompt: text });

    if (text.includes("STUBBORN")) {
      process.on("SIGTERM", () => {});

      const child = Bun.spawn([process.execPath, import.meta.path, "--descendant"], {
        stdio: ["ignore", "ignore", "ignore"],
      });

      record({ event: "child", childPid: child.pid });
      continue;
    }

    if (text.includes("HANG")) continue;

    if (text.includes("CRASH")) process.exit(7);

    if (text.includes("PERMISSION")) {
      pendingPermissions = 2;

      for (const id of ["reject", "cancel"])
        send({
          id,
          method: "session/request_permission",
          params: {
            sessionId,
            toolCall: { toolCallId: id, title: "run_terminal_command", kind: "execute" },
            options: [
              { optionId: "allow", kind: "allow_always", name: "Allow" },
              ...(id === "reject" ? [{ optionId: "deny", kind: "reject_once", name: "Deny" }] : []),
            ],
          },
        });
      continue;
    }

    if (text.includes("TOOL")) {
      send({
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "unexpected" } },
      });
      continue;
    }

    update(sessionId, "agent_thought_chunk", "Hidden reasoning");

    if (text.includes("OVERFLOW")) {
      for (let i = 0; i < 5; i++)
        update(sessionId, text.includes("THOUGHT") ? "agent_thought_chunk" : "agent_message_chunk", "ż".repeat(2048));
      continue;
    }

    update(
      sessionId,
      "agent_message_chunk",
      text.includes("<type>/<slug>") ? "fix/grok-text-generation" : "Grok title",
    );
    send({ id: m.id, result: { stopReason: text.includes("REFUSE") ? "refusal" : "end_turn" } });
  } else if (m.id === "reject" || m.id === "cancel") {
    record({ event: "permission", id: m.id, result: m.result });

    if (--pendingPermissions === 0) {
      update(sessionId, "agent_message_chunk", "Denied");
      send({ id: promptId, result: { stopReason: "end_turn" } });
    }
  } else if (m.id) send({ id: m.id, result: {} });
}
