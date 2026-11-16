#!/usr/bin/env bun
import { appendFileSync, existsSync } from "node:fs";

appendFileSync(
  process.env["RELEASE_TRACE"]!,
  `${JSON.stringify({ pid: process.pid, home: process.env["GROK_HOME"] })}\n`,
);

const marker = process.env["RELEASE_MARKER"];

while (marker && !existsSync(marker)) await Bun.sleep(10);

await import("./agent.ts");
