#!/usr/bin/env bun
/** Git fixture: delegates ordinary commands and real local clones; only named destinations inject progress/failures. */
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);

if (args[0] === "--child") {
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}

const realGit = process.env["CANOPY_FIXTURE_REAL_GIT"];

if (!realGit) throw new Error("Fixture needs the real Git executable");

const name = args.at(-1) ?? "";
const out = (text: string) => process.stderr.write(text);

if (args[0] === "clone" && name.startsWith("fixture-")) {
  writeFileSync(join(process.cwd(), name, "git.pid"), String(process.pid));

  if (name.includes("auth") && process.env["CANOPY_FIXTURE_AUTH_RECOVERED"] !== "1") {
    out(
      "\u001b[31mfatal: Authentication failed for 'https://owner:fixture-url-secret@example.invalid/repo.git'\u001b[0m\n",
    );
    out("Authorization: Bearer fixture-header-secret\npassword=fixture-password token=fixture-token\n");
    out("ghp_fixtureprovidersecret\n");
    process.exit(128);
  }

  if (name.includes("stall") || name.includes("cancel")) {
    const child = Bun.spawn([process.execPath, import.meta.path, "--child"], { stdio: ["ignore", "ignore", "ignore"] });
    writeFileSync(join(process.cwd(), name, "child.pid"), String(child.pid));
    out("Receiving objects: 1% (1/100), 1.0 MiB | 1.0 MiB/s\r");
    setInterval(() => out("Receiving objects: 1% (1/100), 1.0 MiB | 1.0 MiB/s\r"), 50);
    await new Promise(() => {});
  }

  if (name.includes("logged")) {
    out("\u001b[32mCounting objects: 0% (0/2700)\u001b[0m\r");
    out("remote: https://owner:fixture-url-secret@example.invalid/repo.git?token=fixture-query-secret\n");
    out("Authorization: Bearer fixture-header-secret\npassword=fixture-password token=fixture-token\n");
    out("ghp_fixtureprovidersecret\n");
    out("x".repeat(9000) + "fixture-overlong-secret\n");
    out('helper: {"password": "fixture quoted password", "access_token": "fixture-json-secret"}\n');
    await Bun.sleep(300);
    out("Counting objects: 100% (2700/2700)\rCompressing objects: 100% (2700/2700)\n");

    for (let i = 1; i <= 100; i++) {
      out(`Receiving objects: ${i}% (${i * 27}/2700), 12.3 MiB | 3.1 MiB/s\r`);
      await Bun.sleep(20);
    }

    out("Resolving deltas: 100% (100/100)\rUpdating files: 100% (100/100)\n");
  }

  rmSync(join(process.cwd(), name, "git.pid"));
}

// file:// is used by tests so even the delegated git never contacts a real remote.
const delegated =
  args[0] === "clone" && name.includes("logged")
    ? ["clone", "-q", ...args.slice(1).filter((arg) => arg !== "--progress")]
    : args;

const child = Bun.spawn([realGit, ...delegated], { stdio: ["ignore", "inherit", "inherit"] });

process.exit(await child.exited);
