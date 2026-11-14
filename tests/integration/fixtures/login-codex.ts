#!/usr/bin/env bun
/**
 * Codex wire fixture for an expired ChatGPT login: `codex login status` only reads auth.json and says "Logged in", but
 * a turn fails as Codex 0.16x does when the refresh token expired. The device-code sign-in writes a new auth.json.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { JsonObject } from "@canopy/domain";

const home = process.env["CODEX_HOME"]!;
const auth = join(home, "auth.json");

if (process.argv.includes("--version")) {
  console.log("codex-cli 0.166.0");
  process.exit();
}

if (process.argv[2] === "login" && process.argv[3] === "status") {
  console.log(existsSync(auth) ? "Logged in using ChatGPT" : "Not logged in");
  process.exit(existsSync(auth) ? 0 : 1);
}

const send = (message: JsonObject) => process.stdout.write(JSON.stringify(message) + "\n");
const notify = (method: string, params: JsonObject) => send({ method, params });

// Fixture tokens only: an expired login holds the word, a fresh one does not.
const expired = () => existsSync(auth) && readFileSync(auth, "utf8").includes("expired");

function turn(id: number, threadId: string, text: string) {
  const turnId = crypto.randomUUID();
  send({ id, result: { turn: { id: turnId, status: "inProgress", items: [], error: null } } });
  notify("turn/started", { threadId, turn: { id: turnId, status: "inProgress", items: [], error: null } });

  const error =
    expired() || text.includes("FAIL:auth")
      ? {
          message:
            "Error running remote compact task: Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.",
          codexErrorInfo: "unauthorized",
          additionalDetails: null,
        }
      : null;

  if (!error)
    notify("item/completed", {
      threadId,
      turnId,
      item: { id: `answer-${turnId}`, type: "agentMessage", text: "Done" },
    });
  notify("turn/completed", {
    threadId,
    turn: { id: turnId, status: error ? "failed" : "completed", items: [], error },
  });
}

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);

  if (request.id === undefined) continue;
  const { id, params } = request;

  if (request.method === "initialize") send({ id, result: { userAgent: "login-fixture" } });
  else if (request.method === "model/list") send({ id, result: { data: [], nextCursor: null } });
  else if (request.method === "mcpServerStatus/list") {
    const server = { name: "canopy_connectors", runtimeStatus: "connected", toolsError: null, tools: {} };
    send({ id, result: { data: [server], nextCursor: null } });
  } else if (request.method === "thread/start" || request.method === "thread/resume")
    send({ id, result: { thread: { id: params.threadId ?? crypto.randomUUID(), path: null } } });
  else if (request.method === "turn/start")
    turn(id, params.threadId, params.input.map((part: { text?: string }) => part.text ?? "").join("\n"));
  else if (request.method === "account/read") send({ id, result: { account: null, requiresOpenaiAuth: true } });
  else if (request.method === "account/login/start") {
    const loginId = crypto.randomUUID();
    send({
      id,
      result: {
        type: "chatgptDeviceCode",
        loginId,
        verificationUrl: "https://auth.example.test/device",
        userCode: "ABCD-1234",
      },
    });
    writeFileSync(auth, JSON.stringify({ tokens: { access_token: "fixture-fresh-login" } }));
    notify("account/login/completed", { loginId, success: true, error: null });
  } else send({ id, result: {} });
}
