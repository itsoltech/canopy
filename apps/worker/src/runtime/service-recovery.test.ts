import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TurnEndSource, TurnOutcome } from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { ManagedRuntime } from "effect";
import { Journal } from "../journal/index.ts";
import { WorkerHost } from "./host.ts";

const directory = tempDirs();
const invocation = "a".repeat(32);
const replacement = "b".repeat(32);

async function startTurn(path: string, serviceInvocation: string, turnId: string) {
  const runtime = ManagedRuntime.make(Journal.layer(path, false, serviceInvocation));

  try {
    await runtime.runPromise(
      Journal.use((j) => j.append("thread", { turnId, body: { case: "turnStarted", value: {} } })),
    );
    await runtime.runPromise(Journal.use((j) => j.ack("thread", 99n)));
  } finally {
    await runtime.dispose();
  }
}

async function restart(dir: string, serviceInvocation: string) {
  const runtime = ManagedRuntime.make(Journal.layer(join(dir, "journal.db"), false, serviceInvocation));
  const host = new WorkerHost({ runtime, dataDir: dir, clientVersion: "test" });

  try {
    await host.recover();
    const pending = await runtime.runPromise(Journal.use((j) => j.pending(new Map())));
    expect((await host.recover()).turns).toBe(0);

    return pending.flatMap((event) =>
      event.body.case === "turnFinished"
        ? [
            {
              turnId: event.turnId,
              source: event.body.value.source,
              outcome: event.body.value.outcome,
              reason: event.body.value.reason,
            },
          ]
        : [],
    );
  } finally {
    await host.close();
    await runtime.dispose();
  }
}

test.skipIf(process.platform !== "linux")(
  "recovery reports a manager-confirmed OOM only for the matching turn",
  async () => {
    const dir = directory("canopy-service-recovery-");
    const path = join(dir, "journal.db");
    // A worker from before this field was introduced left an open turn.
    const legacy = new Database(path);
    legacy.exec(`CREATE TABLE open_turns (thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, PRIMARY KEY (thread_id, turn_id));
               INSERT INTO open_turns VALUES ('thread', 'legacy')`);
    legacy.close();
    await startTurn(path, invocation, "active");

    const command = join(dir, "journalctl");
    writeFileSync(command, '#!/bin/sh\nprintf "%s\\n" "$@" > "$0.args"\nprintf "oom-kill\\n"\n', { mode: 0o700 });
    const previousPath = process.env["PATH"];
    process.env["PATH"] = `${dir}:${previousPath ?? ""}`;

    try {
      const interrupted = { outcome: TurnOutcome.INTERRUPTED, source: TurnEndSource.SYSTEM };
      expect(await restart(dir, replacement)).toEqual([
        { turnId: "legacy", ...interrupted, reason: "worker restarted mid-turn" },
        { turnId: "active", ...interrupted, reason: "the worker service stopped because of memory pressure" },
      ]);
      const args = readFileSync(`${command}.args`, "utf8").trim().split("\n");
      const groups = [args.slice(args.indexOf("_PID=1"), args.indexOf("+")), args.slice(args.indexOf("+") + 1)];
      const failure = ["MESSAGE_ID=d9b373ed55a64feb8242e02dbe79a49c", "UNIT_RESULT=oom-kill"];
      expect(groups[0]).toEqual(["_PID=1", "UNIT=canopy-worker.service", `INVOCATION_ID=${invocation}`, ...failure]);
      expect(groups[1]).toEqual([
        `_UID=${process.getuid?.()}`,
        `_SYSTEMD_UNIT=user@${process.getuid?.()}.service`,
        "_SYSTEMD_USER_UNIT=init.scope",
        "_COMM=systemd",
        "USER_UNIT=canopy-worker.service",
        `USER_INVOCATION_ID=${invocation}`,
        ...failure,
      ]);

      await startTurn(path, replacement, "no-access");
      writeFileSync(command, '#!/bin/sh\nprintf "oom-kill\\n"\nexit 1\n');
      expect(await restart(dir, invocation)).toEqual([
        { turnId: "no-access", ...interrupted, reason: "worker restarted mid-turn" },
      ]);
    } finally {
      if (previousPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = previousPath;
    }
  },
);

test("a second worker within the same service invocation fences a later OOM even if recovery crashes", async () => {
  const dir = directory("canopy-same-invocation-");
  const path = join(dir, "journal.db");
  await startTurn(path, invocation, "previous-process");

  const second = ManagedRuntime.make(Journal.layer(path, false, invocation));

  try {
    expect(await second.runPromise(Journal.use((j) => j.openTurns()))).toEqual([
      { threadId: "thread", turnId: "previous-process", items: [], interruptRequested: false },
    ]);
  } finally {
    await second.dispose(); // Process disappeared before it could finish recovery.
  }

  expect(await restart(dir, replacement)).toEqual([
    {
      turnId: "previous-process",
      outcome: TurnOutcome.INTERRUPTED,
      source: TurnEndSource.SYSTEM,
      reason: "worker restarted mid-turn",
    },
  ]);
});
