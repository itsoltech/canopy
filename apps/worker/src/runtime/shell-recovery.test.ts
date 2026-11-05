import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { ShellResultSchema } from "@canopy/contracts";
import { tempDir } from "@canopy/testing";
import { Journal } from "../journal/index.ts";
import { Effect, ManagedRuntime } from "effect";
import { WorkerHost } from "./host.ts";
import { killProcessTree } from "@canopy/process-governor";
import { Database } from "bun:sqlite";

test.skipIf(process.platform === "win32")(
  "a recovered durable shell claim interrupts its orphan group and cannot be admitted again",
  async () => {
    const dir = tempDir("canopy-shell-recovery-");
    const path = join(dir, "journal.db");
    const child = spawn("/bin/sh", ["-c", "sleep 60"], { detached: true, stdio: "ignore" });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    const pid = child.pid!;

    const claim = {
      inputId: crypto.randomUUID(),
      threadId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      commandId: crypto.randomUUID(),
      pid,
      result: create(ShellResultSchema, { command: "sleep 60", cwd: dir, status: "running" }),
    };

    const previous = ManagedRuntime.make(Journal.layer(path));
    await previous.runPromise(
      Journal.use((j) =>
        Effect.gen(function* () {
          yield* j.beginShellInput(claim, true);
          yield* j.shellPid(claim.inputId, pid);
        }),
      ),
    );
    await previous.dispose(); // Abrupt loss: no finishShellInput, no WorkerHost.close.
    const runtime = ManagedRuntime.make(Journal.layer(path));
    const host = new WorkerHost({ runtime, dataDir: join(dir, "data"), clientVersion: "test" });

    try {
      expect((await host.recover()).turns).toBe(1);
      await closed;
      expect(() => process.kill(pid, 0)).toThrow();

      const state = await runtime.runPromise(
        Journal.use((j) =>
          Effect.gen(function* () {
            return {
              result: yield* j.shellInput(claim.inputId),
              open: yield* j.openShellInputs(),
              turns: yield* j.openTurns(),
              command: yield* j.commandResult(claim.commandId),
              duplicate: yield* j.beginShellInput(claim, true),
            };
          }),
        ),
      );

      expect(state.result?.status).toBe("interrupted");
      expect(state.result?.reason).toContain("worker restart");
      expect(state.open).toEqual([]);
      expect(state.turns).toEqual([]);
      expect(state.command?.ok).toBe(true);
      expect(state.duplicate).toBeUndefined();
      expect((await host.recover()).turns).toBe(0);
    } finally {
      await killProcessTree(pid);
      await host.close();
      await runtime.dispose();
    }
  },
  10_000,
);

test.skipIf(process.platform === "win32")(
  "recovery never kills a reused PID with a different process identity",
  async () => {
    const dir = tempDir("canopy-shell-pid-reuse-");
    const path = join(dir, "journal.db");
    const child = spawn("/bin/sh", ["-c", "sleep 60"], { detached: true, stdio: "ignore" });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    const pid = child.pid!;
    const runtime = ManagedRuntime.make(Journal.layer(path));
    const host = new WorkerHost({ runtime, dataDir: join(dir, "data"), clientVersion: "test" });

    try {
      await runtime.runPromise(
        Journal.use((j) =>
          Effect.gen(function* () {
            yield* j.beginShellInput(
              {
                inputId: "reused",
                threadId: "thread",
                turnId: "turn",
                commandId: "command",
                pid,
                result: create(ShellResultSchema, { command: "sleep 60", cwd: dir, status: "running" }),
              },
              true,
            );
            yield* j.shellPid("reused", pid);
          }),
        ),
      );
      const db = new Database(path);
      db.query("UPDATE shell_inputs SET process_identity = 'previous-process'").run();
      db.close();
      await host.recover();
      expect(() => process.kill(pid, 0)).not.toThrow();
      expect((await runtime.runPromise(Journal.use((j) => j.shellInput("reused"))))?.status).toBe("interrupted");
    } finally {
      await killProcessTree(pid);
      await closed;
      await host.close();
      await runtime.dispose();
    }
  },
  10_000,
);
