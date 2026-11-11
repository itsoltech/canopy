import { create, toBinary } from "@bufbuild/protobuf";

import { computerLink as link, ui } from "@canopy/contracts";

import { Effect } from "effect";

import { SqlClient } from "effect/sql";

import type { ComputerStore } from "./store.ts";
import { applyThreadDelta } from "@canopy/domain/thread-mirror";
import { mismatch } from "./mirror.ts";
import { readMirrorSnapshot } from "./mirror-snapshot.ts";

export type State = { cursor: string; generation: string; overview: Uint8Array | null; subscription_id: string };

/** A staging generation is durably registered before any projection can be written. */
export const registerMirrorGeneration = (owner: string, node: string, generation: string, state: State) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const fenced = yield* sql`SELECT 1 FROM computer_mirror_state WHERE owner_user_id=${owner}::uuid
        AND origin_node_id=${node} AND subscription_id=${state.subscription_id}::uuid
        AND generation=${state.generation}::uuid AND cursor=${state.cursor} FOR UPDATE`;

        if (!fenced.length) return false;
        yield* sql`INSERT INTO computer_mirror_generations(owner_user_id,origin_node_id,generation,subscription_id,lease_until)
        VALUES(${owner}::uuid,${node},${generation}::uuid,${state.subscription_id}::uuid,now()+interval '5 minutes')`;

        return true;
      }),
    );
  });

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
            subscription_id: string;
          }>`SELECT cursor,generation,subscription_id FROM computer_mirror_state
              WHERE owner_user_id=${owner}::uuid AND origin_node_id=${node} FOR UPDATE`;

          if (!rows[0]) return false;

          if (
            rows[0].cursor !== state.cursor ||
            rows[0].generation !== state.generation ||
            rows[0].subscription_id !== state.subscription_id
          )
            return false;

          if (generation !== state.generation) {
            const staging = yield* sql`UPDATE computer_mirror_generations SET lease_until=now()+interval '5 minutes'
              WHERE owner_user_id=${owner}::uuid AND origin_node_id=${node} AND generation=${generation}::uuid
                AND subscription_id=${state.subscription_id}::uuid AND lease_until>now() RETURNING generation`;

            if (!staging.length) return false;
          } else {
            yield* sql`INSERT INTO computer_mirror_generations(owner_user_id,origin_node_id,generation,subscription_id)
              VALUES(${owner}::uuid,${node},${generation}::uuid,${state.subscription_id}::uuid) ON CONFLICT DO NOTHING`;
          }

          if (update.delta) {
            const delta = update.delta;

            if (delta.baseCursor !== state.cursor || !delta.snapshot?.thread) return yield* Effect.fail(mismatch());

            const saved = yield* readMirrorSnapshot(owner, node, delta.snapshot.thread.id, generation);

            if (!saved) return yield* Effect.fail(mismatch());
            update.snapshot = applyThreadDelta(saved.snapshot, delta);
          }

          if (update.snapshot?.thread) {
            const metadata = create(ui.ThreadSchema, { ...update.snapshot.thread, lastUserTurnChoices: undefined });

            yield* sql`INSERT INTO computer_mirror_threads(owner_user_id,origin_node_id,generation,thread_id,snapshot,thread_metadata)
                VALUES(${owner}::uuid,${node},${generation}::uuid,${update.snapshot.thread.id}::uuid,${toBinary(ui.ThreadSnapshotSchema, update.snapshot)},${toBinary(ui.ThreadSchema, metadata)})
                ON CONFLICT(owner_user_id,origin_node_id,generation,thread_id) DO UPDATE SET snapshot=excluded.snapshot,thread_metadata=excluded.thread_metadata`;
          }

          if (update.removedThreadId)
            yield* sql`DELETE FROM computer_mirror_threads WHERE owner_user_id=${owner}::uuid AND origin_node_id=${node}
              AND generation=${generation}::uuid AND thread_id=${update.removedThreadId}::uuid`;

          if (update.commit) {
            yield* sql`UPDATE computer_mirror_state SET cursor=${update.cursor},generation=${generation}::uuid,overview=coalesce(${nextOverview},overview)
                WHERE owner_user_id=${owner}::uuid AND origin_node_id=${node}`;
          }

          return true;
        }),
      );
    }),
  );
}
