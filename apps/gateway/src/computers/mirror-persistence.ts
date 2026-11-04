import { toBinary } from "@bufbuild/protobuf";

import { computerLink as link, ui } from "@canopy/contracts";

import { Effect } from "effect";

import { SqlClient } from "effect/sql";

import type { ComputerStore } from "./store.ts";

export type State = { cursor: string; generation: string; overview: Uint8Array | null };

export async function commitMirrorUpdate(
  runtime: ComputerStore["runtime"],
  owner: string,
  node: string,
  generation: string,
  state: State,
  update: link.MirrorUpdate,
  nextOverview: Uint8Array | null,
): Promise<boolean> {
  return runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return yield* sql.withTransaction(
        Effect.gen(function* () {
          // Lock against unlink (FK cascade) and other instances consuming the same peer.
          const rows = yield* sql<{
            cursor: string;
            generation: string;
          }>`SELECT cursor,generation FROM computer_mirror_state
              WHERE owner_user_id=${owner}::uuid AND origin_node_id=${node} FOR UPDATE`;

          if (!rows[0]) return false;

          if (rows[0].cursor !== state.cursor || rows[0].generation !== state.generation) return false;

          if (update.snapshot?.thread) {
            yield* sql`INSERT INTO computer_mirror_threads(owner_user_id,origin_node_id,generation,thread_id,snapshot)
                VALUES(${owner}::uuid,${node},${generation}::uuid,${update.snapshot.thread.id}::uuid,${toBinary(ui.ThreadSnapshotSchema, update.snapshot)})
                ON CONFLICT(owner_user_id,origin_node_id,generation,thread_id) DO UPDATE SET snapshot=excluded.snapshot`;
          }

          if (update.removedThreadId)
            yield* sql`DELETE FROM computer_mirror_threads WHERE owner_user_id=${owner}::uuid AND origin_node_id=${node}
              AND generation=${generation}::uuid AND thread_id=${update.removedThreadId}::uuid`;

          if (update.commit) {
            yield* sql`UPDATE computer_mirror_state SET cursor=${update.cursor},generation=${generation}::uuid,overview=coalesce(${nextOverview},overview)
                WHERE owner_user_id=${owner}::uuid AND origin_node_id=${node}`;
            yield* sql`DELETE FROM computer_mirror_threads WHERE owner_user_id=${owner}::uuid AND origin_node_id=${node} AND generation<>${generation}::uuid`;
          }

          return true;
        }),
      );
    }),
  );
}
