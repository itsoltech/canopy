#!/usr/bin/env bun
/** A resumed CLI can publish startup status while the SDK is still loading MCP tools. */
if (!process.argv.includes("--version"))
  process.stdout.write(
    JSON.stringify({
      type: "system",
      subtype: "status",
      status: "compacting",
      session_id: crypto.randomUUID(),
      uuid: crypto.randomUUID(),
    }) + "\n",
  );

await import("./instance-claude.ts");
