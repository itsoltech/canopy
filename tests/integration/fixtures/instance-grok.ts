#!/usr/bin/env bun
/** ACP fixture with durable sessions behind disposable process homes. */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { JsonObject } from "@canopy/domain";
import { recordProbe, releaseProbe } from "./instance-probe.ts";

if (process.argv.includes("--version")) {
  console.log("grok 1.0.70");
  process.exit();
}

const send = (message: JsonObject) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");

recordProbe("grok", "spawn");

async function turn(id: number, params: { sessionId: string; prompt: { text?: string }[] }): Promise<void> {
  recordProbe("grok", "turn", params.sessionId);
  await releaseProbe(params.prompt.map((p) => p.text ?? "").join("\n"));
  recordProbe("grok", "finish", params.sessionId);
  send({
    method: "session/update",
    params: {
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "FIXTURE_OK" } },
    },
  });
  send({ id, result: { stopReason: "end_turn" } });
}

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  const { id, params } = message;

  if (message.method === "initialize")
    send({
      id,
      result: { protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } } },
    });
  else if (message.method === "session/new" || message.method === "session/load") {
    const session = params.sessionId ?? crypto.randomUUID();
    const file = join(process.env["GROK_HOME"]!, "sessions", `${session}.json`);

    if (message.method === "session/load" && !existsSync(file)) {
      send({ id, error: { code: -32000, message: "Session missing" } });
      continue;
    }

    writeFileSync(file, "{}");
    recordProbe("grok", message.method, session);
    send({ id, result: { sessionId: session } });
  } else if (message.method === "session/prompt") void turn(id, params);
  else if (id !== undefined) send({ id, result: {} });
}
