import { create, toJson, type JsonValue } from "@bufbuild/protobuf";
import { timestampNow } from "@bufbuild/protobuf/wkt";
import {
  ItemSchema,
  ItemStatus,
  ThreadEventSchema,
  VisualSchema,
  type ThreadEvent,
  type Visual,
} from "@canopy/contracts";
import { VISUAL_KIT_VERSION, VISUAL_LIMITS, VISUAL_SCHEMA_VERSION } from "@canopy/domain/visuals";
import { HTML_KIT_VERSION } from "@canopy/domain/visual-html-source";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { insertCall } from "./agent-bus-queries.ts";
import type { CallSource } from "./agent-bus-types.ts";
import { Invalid, NotFound } from "./errors.ts";

export interface VisualPublication {
  readonly source: CallSource;
  readonly ownerId: string;
  readonly workerId: string;
  readonly title: string;
  readonly description: string;
  readonly height: number;
  /** Canonical spec JSON, already validated. */
  readonly spec: string;
  readonly htmlDocument?: boolean;
  readonly sha256: string;
  readonly update?: { readonly visualId: string; readonly expectedVersion: number };
}

export interface PublishedVisual {
  readonly result: JsonValue;
  readonly seq: bigint;
  readonly event: ThreadEvent;
}

export interface VisualRow {
  visual_id: string;
  version: number;
  thread_id: string;
  turn_id: string;
  item_id: string;
  title: string;
  description: string;
  height: number;
  schema_version: number;
  kit_version: number;
  html_document: boolean;
  spec: string;
  sha256: string;
  created_at: Date;
}

export const visualItemId = (visualId: string) => `visual-${visualId}`;

/** Gateway-owned ids: a worker can never create or overwrite a visual item with its own events. */
export const isVisualItemId = (itemId: string) => itemId.startsWith("visual-");

/** Worker events that would create, change or extend a visual item. Only the gateway writes those. */
export function gatewayOwnedItem(event: ThreadEvent): boolean {
  switch (event.body.case) {
    case "itemStarted":
    case "itemCompleted": {
      const item = event.body.value.item;

      return item?.content.case === "visual" || isVisualItemId(item?.itemId ?? "");
    }

    case "itemDelta":
      return isVisualItemId(event.body.value.itemId);
    default:
      return false;
  }
}

export function visualManifest(row: Omit<VisualRow, "created_at" | "thread_id" | "turn_id" | "item_id">): Visual {
  return create(VisualSchema, {
    visualId: row.visual_id,
    version: row.version,
    schemaVersion: row.schema_version,
    kitVersion: row.kit_version,
    htmlDocument: row.html_document,
    title: row.title,
    description: row.description,
    height: row.height,
    sha256: row.sha256,
    sizeBytes: BigInt(new TextEncoder().encode(row.spec).length),
  });
}

/** The thread, its pinned worker and the running source turn, locked in that order. */
function lockSource(sql: SqlClient.SqlClient, input: VisualPublication) {
  return Effect.gen(function* () {
    const thread = yield* sql`SELECT id FROM threads WHERE id=${input.source.threadId}::uuid
      AND owner_user_id=${input.ownerId}::uuid AND worker_id=${input.workerId}::uuid
      AND deleted_at IS NULL AND archived_at IS NULL FOR UPDATE`;

    const turn = yield* sql`SELECT id FROM turns WHERE id=${input.source.turnId}::uuid
      AND thread_id=${input.source.threadId}::uuid AND status='running' FOR UPDATE`;

    if (!thread.length || !turn.length) return yield* Effect.fail(new Invalid("This turn is no longer running."));
  });
}

function turnBudget(sql: SqlClient.SqlClient, input: VisualPublication) {
  return Effect.gen(function* () {
    const totals = yield* sql<{ count: string; bytes: string }>`
      SELECT count(*)::text AS count, coalesce(sum(octet_length(spec)),0)::text AS bytes
      FROM thread_visuals WHERE turn_id=${input.source.turnId}::uuid`;

    if (Number(totals[0]!.count) + 1 > VISUAL_LIMITS.perTurn)
      return yield* Effect.fail(
        new Invalid(`This turn already has ${VISUAL_LIMITS.perTurn} visuals. Update one instead.`),
      );

    if (Number(totals[0]!.bytes) + new TextEncoder().encode(input.spec).length > VISUAL_LIMITS.turnSpecBytes)
      return yield* Effect.fail(new Invalid("This turn reached its visual size limit. Use smaller specs."));
  });
}

/** Version, item placement and turn of the visual being updated; only a visual of the calling thread. */
function nextVersion(sql: SqlClient.SqlClient, input: VisualPublication) {
  return Effect.gen(function* () {
    if (!input.update) return { visualId: Bun.randomUUIDv7(), version: 1, itemTurnId: input.source.turnId };

    const rows = yield* sql<{
      version: number;
      thread_id: string;
      html_document: boolean;
    }>`SELECT version, thread_id, html_document FROM thread_visuals
      WHERE visual_id=${input.update.visualId}::uuid ORDER BY version DESC LIMIT 1 FOR UPDATE`;

    const latest = rows[0];

    if (!latest || latest.thread_id !== input.source.threadId)
      return yield* Effect.fail(new Invalid("Visual not found in this thread. Publish a new visual instead."));

    if (latest.html_document !== Boolean(input.htmlDocument))
      return yield* Effect.fail(new Invalid("Keep the visual format when updating. Publish a new visual instead."));

    if (latest.version !== input.update.expectedVersion)
      return yield* Effect.fail(
        new Invalid(
          `Version conflict: this visual is at version ${latest.version}. Retry with expected_version ${latest.version}.`,
        ),
      );

    const item = yield* sql<{ turn_id: string }>`SELECT turn_id FROM thread_items
      WHERE thread_id=${input.source.threadId}::uuid AND item_id=${visualItemId(input.update.visualId)}`;

    return {
      visualId: input.update.visualId,
      version: latest.version + 1,
      itemTurnId: item[0]?.turn_id ?? input.source.turnId,
    };
  });
}

/** One transaction: the immutable version, the upserted manifest item and its event, the call record and audit. */
export function publishVisual(sql: SqlClient.SqlClient, input: VisualPublication) {
  return sql.withTransaction(
    Effect.gen(function* () {
      yield* lockSource(sql, input);
      yield* turnBudget(sql, input);
      const { visualId, version, itemTurnId } = yield* nextVersion(sql, input);
      const itemId = visualItemId(visualId);
      const { source } = input;

      yield* sql`INSERT INTO thread_visuals(visual_id,version,thread_id,owner_user_id,turn_id,call_id,item_id,title,
          description,height,schema_version,kit_version,spec,sha256,html_document)
        VALUES (${visualId}::uuid,${version},${source.threadId}::uuid,${input.ownerId}::uuid,${source.turnId}::uuid,
          ${source.callId}::uuid,${itemId},${input.title},${input.description},${input.height},${VISUAL_SCHEMA_VERSION},
          ${input.htmlDocument ? HTML_KIT_VERSION : VISUAL_KIT_VERSION},${input.spec},${input.sha256},${Boolean(input.htmlDocument)})`;

      const visual = visualManifest({
        visual_id: visualId,
        version,
        title: input.title,
        description: input.description,
        height: input.height,
        schema_version: VISUAL_SCHEMA_VERSION,
        kit_version: input.htmlDocument ? HTML_KIT_VERSION : VISUAL_KIT_VERSION,
        html_document: Boolean(input.htmlDocument),
        sha256: input.sha256,
        spec: input.spec,
      });

      const item = create(ItemSchema, {
        itemId,
        status: ItemStatus.COMPLETED,
        content: { case: "visual", value: visual },
      });

      const locked = yield* sql<{ last_seq: string }>`SELECT last_seq FROM threads WHERE id=${source.threadId}::uuid`;
      const seq = BigInt(locked[0]!.last_seq) + 1n;

      const event = create(ThreadEventSchema, {
        eventId: Bun.randomUUIDv7(),
        threadId: source.threadId,
        turnId: itemTurnId,
        occurredAt: timestampNow(),
        body: { case: "itemCompleted", value: { item } },
      });

      const content = JSON.stringify(toJson(ItemSchema, item));

      yield* sql`INSERT INTO thread_events(thread_id,seq,event_id,origin,turn_id,kind,item_id,payload,occurred_at)
        VALUES (${source.threadId}::uuid,${seq},${event.eventId}::uuid,'gateway',${itemTurnId}::uuid,
          'item_completed',${itemId},${JSON.stringify(toJson(ThreadEventSchema, event))}::jsonb,now())`;
      yield* sql`INSERT INTO thread_items(thread_id,item_id,turn_id,type,status,content,first_seq,last_seq)
        VALUES (${source.threadId}::uuid,${itemId},${itemTurnId}::uuid,'visual','completed',${content}::jsonb,${seq},${seq})
        ON CONFLICT (thread_id,item_id) DO UPDATE SET content=EXCLUDED.content,status='completed',last_seq=EXCLUDED.last_seq`;
      yield* sql`UPDATE threads SET last_seq=${seq} WHERE id=${source.threadId}::uuid`;

      const result: JsonValue = {
        delivered: true,
        visual_id: visualId,
        item_id: itemId,
        version,
        citation_ref: `visual:${visualId}@${version}`,
      };

      const audited = {
        title: input.title,
        description: input.description,
        sha256: input.sha256,
        ...(input.update && { visual_id: input.update.visualId, expected_version: input.update.expectedVersion }),
      };

      const tool = input.htmlDocument ? "render_html" : "render_visual";
      yield* insertCall(sql, { source, tool, args: audited, status: "completed", result });
      yield* sql`INSERT INTO audit_log(id,actor_user_id,action,target_type,target_id,details)
        VALUES (${source.callId}::uuid,${input.ownerId}::uuid,${`thread.${tool}`},'thread',${source.threadId}::uuid,
          ${JSON.stringify({ visual_id: visualId, version, size_bytes: visual.sizeBytes.toString() })}::jsonb)`;

      const published: PublishedVisual = { result, seq, event };

      return published;
    }),
  );
}

/**
 * A version (0 = latest) of a visual that a thread of this owner shows. Forks keep the original visual id; the
 * thread must still contain the visual's item. Anything else reads as missing.
 */
export function readVisual(
  sql: SqlClient.SqlClient,
  ownerId: string,
  threadId: string,
  visualId: string,
  version: number,
) {
  return Effect.gen(function* () {
    // The visual's own thread (also after a move, whose items live in its history), or a fork that shows it.
    const shown = yield* sql`SELECT 1 FROM threads t WHERE t.id=${threadId}::uuid AND t.owner_user_id=${ownerId}::uuid
      AND t.deleted_at IS NULL AND (
        EXISTS (SELECT 1 FROM thread_visuals v WHERE v.visual_id=${visualId}::uuid AND v.thread_id=t.id)
        OR EXISTS (SELECT 1 FROM thread_items i WHERE i.thread_id=t.id AND i.item_id=${visualItemId(visualId)}
          AND i.type='visual'))`;

    const rows = shown.length
      ? yield* sql<VisualRow>`SELECT visual_id,version,thread_id,turn_id,item_id,title,description,height,schema_version,
            kit_version,spec,sha256,html_document,created_at FROM thread_visuals
          WHERE visual_id=${visualId}::uuid AND owner_user_id=${ownerId}::uuid ORDER BY version`
      : [];

    const row = version ? rows.find((r) => r.version === version) : rows.at(-1);

    if (!row) return yield* Effect.fail(new NotFound("visual not found"));

    return { row, versions: rows.map((r) => r.version) };
  });
}
