import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "@canopy/testing";
import { DesktopRuntime, type Secrets } from "../src/runtime/runtime.ts";
import { initialStatus } from "../src/runtime/config.ts";
import { runtimePaths } from "../src/runtime/launch.ts";
import { MigrationJournalFile } from "../src/runtime/migration-state.ts";
import { writeConfiguration } from "../src/runtime/saved-status.ts";

const temp = tempDirs();
const local = { mode: "local", bindHost: "127.0.0.1", allowNetwork: false } as const;

function runtime(directory: string) {
  const secrets: Secrets = {
    databasePassword: randomBytes(32).toString("hex"),
    runtimeDatabasePassword: randomBytes(32).toString("hex"),
    secretsKey: randomBytes(32).toString("base64"),
    serviceToken: randomBytes(32).toString("hex"),
  };

  return new DesktopRuntime(directory, runtimePaths(join(directory, "unused-runtime")), secrets);
}

test("a replacement Desktop runtime keeps Local startup fenced during and after acknowledged cutover", async () => {
  const directory = temp("canopy-desktop-startup-fence-");
  const journal = new MigrationJournalFile(directory);
  const operation = { version: 1, runId: randomUUID(), kind: "move", target: "desktop.invalid" } as const;
  writeConfiguration(directory, local);

  // Leave desktop.json on Local to model interruption after persisting a fence and before switching.
  for (const phase of ["draining", "committed", "completed"] as const) {
    journal.save({ ...operation, phase });
    const replacement = runtime(directory);

    try {
      await replacement.restore();
      expect(replacement.status).toMatchObject({
        phase: "error",
        error: expect.stringContaining("fenced for migration"),
      });
      expect(replacement.pids).toEqual([]);
      await expect(replacement.configure(local)).rejects.toThrow("fenced for migration");
    } finally {
      await replacement.stop();
    }
  }

  // A torn or corrupted record also fails closed, even through the manual configuration path.
  writeFileSync(join(directory, "gateway-migration.json"), '{"version":1,', { mode: 0o600 });
  const replacement = runtime(directory);

  try {
    await expect(replacement.configure(local)).rejects.toThrow("Could not read the gateway migration record");
    expect(replacement.status).toEqual(initialStatus());
    expect(replacement.pids).toEqual([]);
  } finally {
    await replacement.stop();
  }
});
