#!/usr/bin/env bun
/** Observe the instructions sent to a fresh continuation session without inference. */
import { writeFileSync } from "node:fs";
import type { JsonValue } from "@canopy/domain";

if (process.argv[2] === "--version") {
  console.log("codex-cli 0.164.0");
  process.exit(0);
}

let buffer = "";

for await (const chunk of process.stdin) {
  buffer += chunk;
  let index: number;

  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);

    if (!line.trim()) continue;
    const request = JSON.parse(line);

    if (request.id === undefined) continue;
    let result: JsonValue | undefined;

    if (request.method === "initialize") result = { userAgent: "directory-fixture" };
    else if (request.method === "model/list") result = { data: [], nextCursor: null };
    else if (request.method === "thread/goal/get") result = { goal: null };
    else if (["thread/unsubscribe", "thread/backgroundTerminals/clean", "thread/archive"].includes(request.method))
      result = {};
    else if (request.method === "thread/start") {
      process.chdir(request.params.cwd);
      writeFileSync("worker-started.txt", process.cwd());
      writeFileSync("harness-instructions.txt", request.params.developerInstructions ?? "");
      result = { thread: { id: crypto.randomUUID(), path: null } };
    }

    process.stdout.write(
      JSON.stringify(
        result
          ? { id: request.id, result }
          : { id: request.id, error: { code: -32601, message: "unsupported fixture method" } },
      ) + "\n",
    );
  }
}
