#!/usr/bin/env bun
/** Codex wire fixture with real durable session files and independently releasable turns. */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { JsonObject } from "@canopy/domain";
import { recordProbe, releaseProbe } from "./instance-probe.ts";

if (process.argv.includes("--version")) {
  console.log("codex-cli 0.164.0");
  process.exit();
}

const home = process.env["CODEX_HOME"]!;

mkdirSync(join(home, "sessions"), { recursive: true });

recordProbe("codex", "spawn");

const providers = new Map<string, string>();
const send = (message: JsonObject) => process.stdout.write(JSON.stringify(message) + "\n");
const notify = (method: string, params: JsonObject) => send({ method, params });

async function turn(id: number, params: { threadId: string; input: { text?: string }[] }): Promise<void> {
  const turnId = crypto.randomUUID();
  const threadId = params.threadId;
  const text = params.input.map((i) => i.text ?? "").join("\n");
  send({ id, result: { turn: { id: turnId, status: "inProgress", items: [], error: null } } });
  notify("turn/started", { threadId, turn: { id: turnId, status: "inProgress", items: [], error: null } });
  recordProbe("codex", "turn", threadId, providers.get(threadId));
  await releaseProbe(text);
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

    if (request.method === "thread/resume" && !existsSync(file)) {
      send({ id, error: { code: -32000, message: "Session missing from CODEX_HOME" } });
      continue;
    }

    writeFileSync(file, "{}");
    providers.set(session, params.modelProvider);
    recordProbe("codex", request.method, session, params.modelProvider);
    send({ id, result: { thread: { id: session, path: null } } });
  } else if (request.method === "turn/start") void turn(id, params);
  else send({ id, result: {} });
}
