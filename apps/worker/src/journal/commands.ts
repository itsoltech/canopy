import type { Database } from "bun:sqlite";
import { create, fromBinary, toBinary, type MessageInitShape } from "@bufbuild/protobuf";
import { CommandResultSchema } from "@canopy/contracts";
import { Effect } from "effect";
import type { JournalError } from "./journal.ts";

export function commandTracking(
  db: Database,
  attempt: <A>(operation: string, run: () => A) => Effect.Effect<A, JournalError>,
) {
  const upsert = db.query(
    `INSERT INTO processed_commands (command_id, result, processed_at) VALUES ($id, $result, $at)
     ON CONFLICT (command_id) DO UPDATE SET result = excluded.result, processed_at = excluded.processed_at`,
  );

  const select = db.query<{ result: Uint8Array }, { id: string }>(
    "SELECT result FROM processed_commands WHERE command_id = $id",
  );

  const purge = db.query("DELETE FROM processed_commands WHERE processed_at < $before");

  return {
    rememberCommand: Effect.fn("Journal.rememberCommand")((result: MessageInitShape<typeof CommandResultSchema>) =>
      attempt("rememberCommand", () => {
        const message = create(CommandResultSchema, result);
        upsert.run({ id: message.commandId, result: toBinary(CommandResultSchema, message), at: Date.now() });
      }),
    ),
    commandResult: Effect.fn("Journal.commandResult")((commandId: string) =>
      attempt("commandResult", () => {
        const row = select.get({ id: commandId });

        return row ? fromBinary(CommandResultSchema, row.result) : undefined;
      }),
    ),
    purgeCommands: Effect.fn("Journal.purgeCommands")((maxAgeMs: number) =>
      attempt("purgeCommands", () => purge.run({ before: Date.now() - maxAgeMs }).changes),
    ),
  };
}
