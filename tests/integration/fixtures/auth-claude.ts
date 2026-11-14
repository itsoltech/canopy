#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const home = process.env["CLAUDE_SECURESTORAGE_CONFIG_DIR"] || process.env["CLAUDE_CONFIG_DIR"]!;
const file = join(home, ".credentials.json");
const args = process.argv.slice(2).join(" ");

if (args === "--version") {
  console.log("2.1.308");
  process.exit();
}

if (args === "auth status --json") {
  console.log(
    JSON.stringify({
      loggedIn: existsSync(file),
      authMethod: "claude.ai",
      subscriptionType: existsSync(file) && readFileSync(file, "utf8") === "fixture-refreshed" ? "refreshed" : "max",
    }),
  );
  process.exit(existsSync(file) ? 0 : 1);
}

if (args === "auth logout") {
  if (existsSync(file)) unlinkSync(file);
  process.exit();
}

if (args === "auth login") {
  console.log("https://claude.com/cai/oauth/authorize?state=fixture-state");
  console.log("Paste code here if prompted >");
  const code = await Bun.stdin.text();

  if (code.trim() === "fixture-code") {
    writeFileSync(file, "fixture-login", { mode: 0o600 });
    process.exit();
  }

  console.error("fixture-secret-must-not-leak");
  process.exit(1);
}

if (existsSync(join(home, "refuse-runtime"))) process.exit(1);

await import("./instance-claude.ts");
