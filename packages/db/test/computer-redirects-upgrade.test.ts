import { expect, test } from "bun:test";
import { Effect, ManagedRuntime } from "effect";
import { Migrator, SqlClient } from "effect/sql";
import { migrate, migrations } from "../src/index.ts";
import { dockerAvailable, startPostgres } from "../src/testing.ts";

test.skipIf(!dockerAvailable)(
  "redirect upgrade reconstructs committed moves in both directions and retains the pairing",
  async () => {
    const pg = await startPostgres();
    const runtime = ManagedRuntime.make(pg.layer);
    const self = "a".repeat(64);
    const peer = "b".repeat(64);
    const phantom = "c".repeat(64);
    const owner = crypto.randomUUID();
    const thread = crypto.randomUUID();
    const child = crypto.randomUUID();
    const bot = crypto.randomUUID();

    try {
      await runtime.runPromise(
        Migrator.make({})({
          loader: migrations.pipe(Effect.map((all) => all.filter(([id]) => id < 182))),
          table: "schema_migrations",
        }),
      );
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO users(id,email,display_name,role) VALUES(${owner}::uuid,'move@example.test','Owner','user')`;
          yield* sql`INSERT INTO computer_identity(owner_user_id,node_id,name,certificate,private_key)
        VALUES(${owner}::uuid,${self},'This home','fixture',decode('00','hex'))`;
          yield* sql`INSERT INTO computer_peers(owner_user_id,node_id,name,certificate,fingerprint,share_config,peer_share_config)
        VALUES(${owner}::uuid,${peer},'Peer','paired certificate','paired fingerprint',true,true)`;
          yield* sql`INSERT INTO computer_moves(owner_user_id,id,role,peer_node_id,kind,item_id,state,frozen)
        VALUES(${owner}::uuid,gen_random_uuid(),'source',${peer},'thread',${thread}::uuid,'done',
          ${JSON.stringify({ family: [thread, child] })}::jsonb),
          (${owner}::uuid,gen_random_uuid(),'target',${peer},'bot',${bot}::uuid,'done','{}')`;
          yield* sql`INSERT INTO computer_redirects(owner_user_id,item_id,kind,from_node_id,home_node_id,moved_at)
        VALUES(${owner}::uuid,${thread}::uuid,'thread',${self},${peer},now()),
          (${owner}::uuid,${child}::uuid,'bot',${phantom},${peer},now()),
          (${owner}::uuid,gen_random_uuid(),'thread',${peer},${phantom},now())`;
        }),
      );
      expect(await runtime.runPromise(migrate)).toContainEqual([182, "verified_computer_redirects"]);
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql`SELECT kind,item_id,from_node_id,home_node_id,basis FROM computer_redirects`;
          expect(rows).toHaveLength(3);

          for (const id of [thread, child])
            expect(rows).toContainEqual({
              kind: "thread",
              item_id: id,
              from_node_id: self,
              home_node_id: peer,
              basis: "local_move",
            });
          expect(rows).toContainEqual({
            kind: "bot",
            item_id: bot,
            from_node_id: peer,
            home_node_id: self,
            basis: "local_move",
          });
          expect(yield* sql`SELECT certificate,fingerprint,share_config,peer_share_config FROM computer_peers`).toEqual(
            [
              {
                certificate: "paired certificate",
                fingerprint: "paired fingerprint",
                share_config: true,
                peer_share_config: true,
              },
            ],
          );
        }),
      );
    } finally {
      await runtime.dispose();
      await pg.stop();
    }
  },
  60_000,
);
