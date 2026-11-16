import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { databaseReady } from "../src/runtime/database-ready.ts";

test("PostgreSQL's administrator refusal across stderr chunks replaces the readiness timeout", async () => {
  const child = spawn(process.execPath, [
    "-e",
    `process.stderr.write('Execution of PostgreSQL by a user with administrative permissions is not\\n');
     setTimeout(() => process.stderr.write('permitted.\\nThe server must be started under an unprivileged user ID.\\n'), 20);`,
  ]);

  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const started = performance.now();

  try {
    await expect(databaseReady(child, async () => false, 2000)).rejects.toThrow(
      "The local database cannot run with administrator rights. Close Canopy and open it without “Run as administrator”.",
    );
    expect(performance.now() - started).toBeLessThan(1500);
    expect(child.stderr?.listenerCount("data")).toBe(0);
  } finally {
    if (child.exitCode === null) child.kill();
    await closed;
  }
});

test("other database startup failures keep their readiness error without administrator advice", async () => {
  const child = spawn(process.execPath, ["-e", "process.stderr.write('FATAL: could not bind IPv4 address\\n')"]);
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));

  try {
    await expect(databaseReady(child, async () => false, 300)).rejects.toThrow(
      "Service did not become ready; see the desktop logs",
    );
    expect(child.stderr?.listenerCount("data")).toBe(0);
  } finally {
    if (child.exitCode === null) child.kill();
    await closed;
  }
});
