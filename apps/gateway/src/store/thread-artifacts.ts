import { create, fromBinary, fromJson, toBinary, type JsonValue } from "@bufbuild/protobuf";
import { ItemSchema, ItemStatus, ui, type Item } from "@canopy/contracts";
import { isPublishedReply, turnProgress } from "@canopy/domain/work-fold";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { NotFound } from "./errors.ts";

export function artifactManifest(item?: Item): Item | undefined {
  if (!item || item.status !== ItemStatus.COMPLETED) return undefined;

  if (isPublishedReply(item.content)) return item;

  if (item.content.case !== "agentMessage" || !item.content.value.images.length) return undefined;

  return create(ItemSchema, {
    itemId: item.itemId,
    status: item.status,
    content: {
      case: "imageGallery",
      value: { sourceItemId: item.itemId, images: item.content.value.images },
    },
  });
}

/** Moved history and legacy linked snapshots retain transcript order (oldest first). */
export function snapshotArtifacts(snapshot: ui.ThreadSnapshot) {
  const visible = new Set(
    snapshot.turns.filter((t) => !t.inherited && !t.rewindId && turnProgress(t.status) !== "live").map((t) => t.id),
  );

  const items: Item[] = [];

  for (const entry of snapshot.items) {
    const item = !entry.inherited && visible.has(entry.turnId) && artifactManifest(entry.item);

    if (item) items.push(item);
  }

  return items.reverse();
}

export function localThreadArtifacts(owner: string, thread: string) {
  return SqlClient.SqlClient.use((sql) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;

        const owned = yield* sql`SELECT id FROM threads
          WHERE id=${thread}::uuid AND owner_user_id=${owner}::uuid AND deleted_at IS NULL`;

        if (!owned.length) return yield* Effect.fail(new NotFound("thread not found"));

        const rows = yield* sql<{ content: JsonValue }>`SELECT CASE WHEN i.type='agent_message'
            THEN i.content #- '{agentMessage,text}' ELSE i.content END AS content
          FROM thread_items i JOIN turns u ON u.id=i.turn_id
          WHERE i.thread_id=${thread}::uuid AND i.status='completed' AND (i.type IN ('image_gallery','published_video','visual')
            OR (i.type='agent_message' AND i.content->'agentMessage'->'images'->0 IS NOT NULL))
            AND u.status IN ('completed','failed','interrupted','cancelled')
            AND u.rewind_id IS NULL
          ORDER BY i.first_seq DESC,i.item_id DESC`;

        const items = rows.flatMap(
          (row) => artifactManifest(fromJson(ItemSchema, row.content, { ignoreUnknownFields: true })) ?? [],
        );

        // The prefix brought from a previous home is immutable and precedes the local sequence.
        const moved = yield* sql<{ chunk: Uint8Array }>`SELECT substring(m.history FROM p FOR 4194304) AS chunk
          FROM computer_moved_threads m CROSS JOIN LATERAL generate_series(1,octet_length(m.history),4194304) AS p
          WHERE m.thread_id=${thread}::uuid ORDER BY p`;

        if (!moved.length) return items;
        const snapshot = fromBinary(ui.ThreadSnapshotSchema, Buffer.concat(moved.map((row) => row.chunk)));

        return items.concat(snapshotArtifacts(snapshot));
      }),
    ),
  );
}

/** Keep each gRPC / linked response bounded even for years of publications. */
export function* artifactBatches(items: readonly Item[]) {
  const seen = new Set<string>();
  let batch = create(ui.ListThreadArtifactsResponseSchema);
  let bytes = 0;

  for (const item of items) {
    if (seen.has(item.itemId)) continue;
    seen.add(item.itemId);
    const size = toBinary(ItemSchema, item).length + 6;

    if (bytes && bytes + size > 256 * 1024) {
      yield batch;
      batch = create(ui.ListThreadArtifactsResponseSchema);
      bytes = 0;
    }

    batch.items.push(item);
    bytes += size;
  }

  yield batch;
}
