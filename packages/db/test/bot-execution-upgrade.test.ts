import { expect, test } from "bun:test";
import { Effect, ManagedRuntime } from "effect";
import { Migrator, SqlClient } from "effect/sql";
import { migrate, migrations } from "../src/index.ts";
import { dockerAvailable, startPostgres } from "../src/testing.ts";

test.skipIf(!dockerAvailable)(
  "bot execution migration recovers admitted jobs from the journal and leaves unstarted jobs unconfirmed",
  async () => {
    const pg = await startPostgres();
    const runtime = ManagedRuntime.make(pg.layer);

    try {
      await runtime.runPromise(
        Migrator.make({})({
          loader: migrations.pipe(Effect.map((all) => all.filter(([id]) => id < 175))),
          table: "schema_migrations",
        }),
      );
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const user = Bun.randomUUIDv7();
          const worker = Bun.randomUUIDv7();
          const bot = Bun.randomUUIDv7();

          yield* sql`INSERT INTO users(id,email,display_name,role) VALUES(${user}::uuid,'upgrade@localhost','Owner','user')`;
          yield* sql`INSERT INTO workers(id,owner_user_id,name,credential_hash)
            VALUES(${worker}::uuid,${user}::uuid,'Worker','fixture')`;
          yield* sql`INSERT INTO bots(id,owner_user_id,client_request_id,configuration,provider,provider_instance)
            VALUES(${bot}::uuid,${user}::uuid,'bot','{}','codex','native')`;

          for (const job of ["admitted", "acknowledged", "finished"]) {
            const turn = Bun.randomUUIDv7();
            yield* sql`INSERT INTO bot_turns(id,bot_id,client_request_id,input,status)
              VALUES(${turn}::uuid,${bot}::uuid,${job},'',${job === "finished" ? "completed" : "running"})`;
            yield* sql`INSERT INTO worker_commands(id,worker_id,kind,status,payload,expires_at)
              VALUES(${turn}::uuid,${worker}::uuid,'runBotTurn','completed',decode('','hex'),now())`;
            yield* sql`INSERT INTO bot_harness_turns(turn_id,bot_id,worker_id,command_id,outcome)
              VALUES(${turn}::uuid,${bot}::uuid,${worker}::uuid,${turn}::uuid,${job === "finished" ? 1 : null})`;

            if (job !== "acknowledged")
              yield* sql`INSERT INTO bot_harness_events(event_id,turn_id,worker_id,journal_id,journal_seq,payload)
                VALUES(gen_random_uuid(),${turn}::uuid,${worker}::uuid,'fixture-journal',1,decode('5a00','hex'))`;
          }
        }),
      );
      expect(await runtime.runPromise(migrate)).toContainEqual([175, "bot_execution_start"]);

      const starts = await runtime.runPromise(
        Effect.flatMap(
          SqlClient.SqlClient,
          (sql) => sql`SELECT t.client_request_id AS job,h.started_journal_id AS journal
            FROM bot_turns t JOIN bot_harness_turns h ON h.turn_id=t.id ORDER BY job`,
        ),
      );

      expect(starts).toEqual([
        { job: "acknowledged", journal: null },
        { job: "admitted", journal: "fixture-journal" },
        { job: "finished", journal: null },
      ]);
    } finally {
      await runtime.dispose();
      await pg.stop();
    }
  },
  60_000,
);
