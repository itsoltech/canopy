import type { Database } from "bun:sqlite";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { CommandResultSchema, ShellResultSchema, type ShellResult, type ThreadEvent } from "@canopy/contracts";
import type { ThreadEventInit, JournalError } from "./journal.ts";
import { Effect } from "effect";
import { shellProcessIdentity } from "../runtime/shell-process-identity.ts";

export interface OpenShellInput {
  inputId: string;
  threadId: string;
  turnId: string;
  commandId: string;
  pid: number;
  processIdentity?: string;
  result: ShellResult;
}

export function shellTracking(
  db: Database,
  attempt: <A>(operation: string, run: () => A) => Effect.Effect<A, JournalError>,
  append: (threadId: string, event: ThreadEventInit) => ThreadEvent,
) {
  db.exec(`CREATE TABLE IF NOT EXISTS shell_inputs (
    input_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL,
    command_id TEXT NOT NULL, result BLOB NOT NULL, pid INTEGER NOT NULL DEFAULT 0,
    process_identity TEXT NOT NULL DEFAULT '', running INTEGER NOT NULL
  )`);
  const select = db.query<{ result: Uint8Array }, [string]>("SELECT result FROM shell_inputs WHERE input_id = ?");

  const begin = db.transaction((input: OpenShellInput, startTurn: boolean) => {
    const previous = select.get(input.inputId);

    if (previous) return undefined;
    db.query(
      "INSERT INTO shell_inputs (input_id, thread_id, turn_id, command_id, result, running) VALUES (?, ?, ?, ?, ?, 1)",
    ).run(input.inputId, input.threadId, input.turnId, input.commandId, toBinary(ShellResultSchema, input.result));

    // A crash before the final answer must never redeliver a shell command as new work.
    const failure = create(CommandResultSchema, {
      commandId: input.commandId,
      ok: startTurn,
      errorCode: "SHELL_INTERRUPTED",
      errorMessage: "Command interrupted by a worker restart. Send a new message to run it again.",
    });

    db.query("INSERT OR REPLACE INTO processed_commands (command_id, result, processed_at) VALUES (?, ?, ?)").run(
      input.commandId,
      toBinary(CommandResultSchema, failure),
      Date.now(),
    );
    const events: ThreadEvent[] = [];

    if (startTurn)
      events.push(append(input.threadId, { turnId: input.turnId, body: { case: "turnStarted", value: {} } }));
    events.push(
      append(input.threadId, {
        turnId: input.turnId,
        body: { case: "shellInputPrepared", value: { inputId: input.inputId, result: input.result } },
      }),
    );

    return events;
  });

  const finish = db.transaction((inputId: string, result: ShellResult) => {
    const row = db
      .query<{ thread_id: string; turn_id: string }, [string]>(
        "SELECT thread_id, turn_id FROM shell_inputs WHERE input_id = ?",
      )
      .get(inputId);

    if (!row) throw new Error("Shell input was not admitted");

    const event = append(row.thread_id, {
      turnId: row.turn_id,
      body: { case: "shellInputPrepared", value: { inputId, result } },
    });

    const safe = event.body.case === "shellInputPrepared" ? event.body.value.result : undefined;

    if (!safe) throw new Error("Shell result missing");
    db.query("UPDATE shell_inputs SET result = ?, running = 0 WHERE input_id = ?").run(
      toBinary(ShellResultSchema, safe),
      inputId,
    );

    return event;
  });

  return {
    beginShellInput: (input: OpenShellInput, startTurn: boolean) =>
      attempt("beginShellInput", () => begin(input, startTurn)),
    shellInput: (inputId: string) =>
      attempt("shellInput", () => {
        const row = select.get(inputId);

        return row ? fromBinary(ShellResultSchema, row.result) : undefined;
      }),
    shellPid: (inputId: string, pid: number) =>
      attempt("shellPid", () => {
        db.query("UPDATE shell_inputs SET pid = ?, process_identity = ? WHERE input_id = ? AND running = 1").run(
          pid,
          shellProcessIdentity(pid),
          inputId,
        );
      }),
    finishShellInput: (inputId: string, result: ShellResult) =>
      attempt("finishShellInput", () => finish(inputId, result)),
    openShellInputs: () =>
      attempt("openShellInputs", () =>
        db
          .query<
            {
              input_id: string;
              thread_id: string;
              turn_id: string;
              command_id: string;
              pid: number;
              process_identity: string;
              result: Uint8Array;
            },
            []
          >("SELECT * FROM shell_inputs WHERE running = 1")
          .all()
          .map((r): OpenShellInput => ({
            inputId: r.input_id,
            threadId: r.thread_id,
            turnId: r.turn_id,
            commandId: r.command_id,
            pid: r.pid,
            processIdentity: r.process_identity,
            result: fromBinary(ShellResultSchema, r.result),
          })),
      ),
  };
}
