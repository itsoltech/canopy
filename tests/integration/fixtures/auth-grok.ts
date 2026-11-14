#!/usr/bin/env bun
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const home = process.env["GROK_HOME"]!;
const file = process.env["GROK_AUTH_PATH"] || join(home, "auth.json");
const args = process.argv.slice(2).join(" ");

if (args === "--version") {
  console.log("grok 1.0.70");
  process.exit();
}

if (args === "logout") {
  if (existsSync(file)) unlinkSync(file);
  process.exit();
}

if (args === "login --device-auth") {
  console.log("Open this URL in your browser to approve:");
  console.log("https://accounts.x.ai/sign-in?user_code=ABCD-1234");
  console.log("Then enter this code: ABCD-1234");

  while (!existsSync(join(home, "complete"))) await Bun.sleep(25);

  if (existsSync(join(home, "fail"))) {
    console.error("fixture-secret-must-not-leak");
    process.exit(1);
  }

  writeFileSync(file, "fixture-login", { mode: 0o600 });
  process.exit();
}

await import("../../../apps/worker/src/providers/grok/fixtures/agent.ts");
