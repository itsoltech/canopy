import { fromBinary, type Message } from "@bufbuild/protobuf";
import { ui, type Item } from "@canopy/contracts";
import { isEntityId, splitId } from "@canopy/domain/computers";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { artifactBatches, artifactManifest, snapshotArtifacts } from "../store/thread-artifacts.ts";
import { readMirrorSnapshot } from "./mirror-snapshot.ts";
import { qualify } from "./remote-ids.ts";
import type { LinkedComputers } from "./runtime.ts";

export async function* linkedArtifacts(
  computers: LinkedComputers,
  node: string,
  request: ui.ListThreadArtifactsRequest,
  send: (request: Message) => AsyncIterable<Message>,
) {
  if (!isEntityId(request.threadId)) throw new ConnectError("Invalid thread ID", Code.InvalidArgument);

  if (computers.reachable().includes(node)) {
    let started = false;

    try {
      for await (const batch of send(request)) {
        started = true;
        yield batch;
      }

      return;
    } catch (error) {
      if (
        started ||
        !(error instanceof ConnectError) ||
        ![Code.Unimplemented, Code.Unavailable, Code.DeadlineExceeded].includes(error.code)
      )
        throw error;
    }
  }

  const items = await computers.store.runtime.runPromise(
    mirrorArtifacts(computers.store.owner, node, splitId(request.threadId).id),
  );

  if (!items) throw new ConnectError("Connect the thread’s computer to read its artifacts.", Code.Unavailable);

  for (const batch of artifactBatches(items)) {
    qualify(ui.ListThreadArtifactsResponseSchema, batch, node);
    yield batch;
  }
}

function mirrorArtifacts(owner: string, node: string, thread: string) {
  return SqlClient.SqlClient.use((sql) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;

        const header = (yield* sql<{ epoch: string | null; thread_metadata: Uint8Array }>`
          SELECT r.visible_epoch AS epoch,t.thread_metadata FROM computer_mirror_threads t
          JOIN computer_mirror_state s USING(owner_user_id,origin_node_id,generation)
          JOIN computer_peers p ON p.owner_user_id=t.owner_user_id AND p.node_id=t.origin_node_id
          LEFT JOIN thread_range_state r ON r.owner_user_id=t.owner_user_id
            AND r.origin_node_id=t.origin_node_id AND r.thread_id=t.thread_id
          WHERE t.owner_user_id=${owner}::uuid AND t.origin_node_id=${node} AND t.thread_id=${thread}::uuid
            AND (p.via_node_id IS NULL OR p.relay_role IN ('home','both'))`)[0];

        if (!header || fromBinary(ui.ThreadSchema, header.thread_metadata).deletedAt) return undefined;

        if (!header.epoch) {
          const saved = yield* readMirrorSnapshot(owner, node, thread);

          return saved && snapshotArtifacts(saved.snapshot);
        }

        // Older receivers stored no item classification. Stream those candidates without
        // retaining tool output, and use the persisted turn at this same visible checkpoint.
        const rows = sql<{ item: Uint8Array; turn: Uint8Array }>`
          SELECT i.payload AS item,u.payload AS turn FROM thread_range_entities i
          JOIN thread_range_entities u USING(owner_user_id,origin_node_id,thread_id,epoch,turn_id)
          WHERE i.owner_user_id=${owner}::uuid AND i.origin_node_id=${node} AND i.thread_id=${thread}::uuid
            AND i.epoch=${header.epoch}::uuid AND i.kind='item' AND i.state IN ('artifact','')
            AND u.kind='turn' AND u.state IN ('completed','failed','interrupted','cancelled')
          ORDER BY i.ordinal DESC,i.entity_key DESC`;

        const items: Item[] = [];

        yield* Stream.runForEachArray(rows.stream, (page) =>
          Effect.sync(() => {
            for (const row of page) {
              const entry = fromBinary(ui.ThreadSyncRecordSchema, row.item).value;
              const item = entry.case === "item" && !entry.value.inherited && artifactManifest(entry.value.item);

              if (!item) continue;
              const turn = fromBinary(ui.ThreadSyncRecordSchema, row.turn).value;

              if (turn.case === "turn" && !turn.value.inherited && !turn.value.rewindId) items.push(item);
            }
          }),
        );

        return items;
      }),
    ),
  );
}
