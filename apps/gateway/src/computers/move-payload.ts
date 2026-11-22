import { fromBinary, type JsonValue } from "@bufbuild/protobuf";

import { Effect, Schema } from "effect";

import { SqlClient } from "effect/sql";

import { computerLink as link } from "@canopy/contracts";

import { qualifyId } from "@canopy/domain/computers";

import { readMovePayload } from "./move-files.ts";

import type { ComputerStore } from "./store.ts";

/**
 * Stage 8 of docs/linked-computers.md: the database side of moving a thread (with its side threads)
 * or a bot. The source freezes, exports and commits; the target stages and applies. Every step is
 * one transaction or idempotent, so a restart at any point resumes or rolls back cleanly.
 */
export type Sql = SqlClient.SqlClient;

/** Files and blobs of a thread that fit one move message (the link's message limit is 48 MiB). */
export const MAX_FILES = 40 * 1024 * 1024;

export const ThreadRowSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  parent_thread_id: Schema.NullOr(Schema.String),
  title: Schema.String,
  title_source: Schema.String,
  provider: Schema.String,
  provider_profile_id: Schema.NullOr(Schema.String),
  settings: Schema.Struct({
    model: Schema.optionalKey(Schema.String),
    effort: Schema.optionalKey(Schema.String),
    serviceTier: Schema.optionalKey(Schema.String),
    permissionMode: Schema.optionalKey(Schema.String),
    instructions: Schema.optionalKey(Schema.String),
    sandboxProfile: Schema.optionalKey(Schema.MutableJson),
  }),
  cwd: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  archived_at: Schema.NullOr(Schema.String),
  auto_archive_on_merge: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  snoozed: Schema.optionalKey(Schema.Boolean),
  snoozed_until: Schema.optionalKey(Schema.NullOr(Schema.String)),
  runtime: Schema.String,
  project_id: Schema.String,
  memory_audience: Schema.optionalKey(Schema.String),
  remote_parent_ref: Schema.NullOr(Schema.String),
  remote_parent_kind: Schema.NullOr(Schema.String),
  last_seq: Schema.Union([Schema.String, Schema.Number]),
});

export type ThreadRowJson = typeof ThreadRowSchema.Type;

export function threadRowJson(json: string): ThreadRowJson {
  const row = Schema.decodeUnknownSync(ThreadRowSchema)(JSON.parse(json));

  if (row.settings.sandboxProfile != null)
    throw new MoveRefused("Threads with a sandbox profile must stay on their home computer.");

  return row;
}

export const JsonRow = Schema.Record(Schema.String, Schema.MutableJson);

export const BotRowsSchema = Schema.Struct({
  bot: Schema.StructWithRest(
    Schema.Struct({
      id: Schema.String,
      provider: Schema.String,
      provider_instance: Schema.String,
      last_read_seq: Schema.Union([Schema.Number, Schema.String]),
      configuration: Schema.StructWithRest(Schema.Struct({ name: Schema.optionalKey(Schema.String) }), [JsonRow]),
    }),
    [JsonRow],
  ),
  turns: Schema.Array(JsonRow),
  messages: Schema.Array(
    Schema.StructWithRest(Schema.Struct({ id: Schema.String, seq: Schema.Union([Schema.Number, Schema.String]) }), [
      JsonRow,
    ]),
  ),
  tool_calls: Schema.Array(JsonRow),
  approvals: Schema.Array(JsonRow),
  handoff_notes: Schema.Array(JsonRow),
  routines: Schema.Array(JsonRow),
  wakeups: Schema.Array(JsonRow),
  grants: Schema.Array(
    Schema.StructWithRest(Schema.Struct({ connector_type: Schema.String, name: Schema.String }), [JsonRow]),
  ),
  mcp: Schema.Array(Schema.StructWithRest(Schema.Struct({ name: Schema.String }), [JsonRow])),
});

export type BotRows = typeof BotRowsSchema.Type;

export const botRowsJson = (json: string): BotRows => Schema.decodeUnknownSync(BotRowsSchema)(JSON.parse(json));

export type Frozen = { schedules?: { id: string; status: string; next_run_at: string | null }[]; family?: string[] };

// ------------------------------------------------------------------ target: stage, apply, discard

export type MoveRow = {
  id: string;
  role: "source" | "target";
  peer_node_id: string;
  kind: "thread" | "bot";
  item_id: string;
  batch_id: string | null;
  title: string;
  state: string;
  placement: { workspaceId?: string; projectId?: string };
  redo: string[];
  frozen: Frozen;
  error: string;
  created_at: Date;
  updated_at: Date;
};

export class MoveRefused extends Error {}

/**
 * The columns of a `MoveRow`. Never `SELECT *`: a target's staged export (`payload`) can be larger than the database
 * driver takes in one row, so only `payloadOf` reads it, in parts.
 */
export const MOVE_COLUMNS =
  "id, role, peer_node_id, kind, item_id, batch_id, title, state, placement, redo, frozen, error, created_at, updated_at";

export const payloadOf = async (store: ComputerStore, move: MoveRow) =>
  fromBinary(link.MovePrepareSchema, await readMovePayload(store, move.id));

/** Rows from another computer of the same schema: only the columns both have, defaults for the rest. */
export function insertRows(
  sql: Sql,
  table: string,
  rows: readonly { [column: string]: JsonValue | undefined }[],
  options: { omit?: string[]; order?: string; strict?: boolean } = {},
) {
  return Effect.gen(function* () {
    if (!rows.length) return;

    const columns = (yield* sql.unsafe<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1`,
      [table],
    ))
      .map((c) => c.column_name)
      .filter((c) => !options.omit?.includes(c) && rows.some((r) => c in r));

    const list = columns.map((c) => `"${c}"`).join(", ");
    yield* sql.unsafe(
      `INSERT INTO ${table} (${list}) SELECT ${list} FROM json_populate_recordset(null::${table}, $1::json) AS r${options.order ? ` ORDER BY r."${options.order}"` : ""}
      ${options.strict ? "" : "ON CONFLICT DO NOTHING"}`,
      [JSON.stringify(rows)],
    );
  });
}

export const qualifiedNew = (id: string, home: string, self: string) => (home === self ? id : qualifyId(id, home));
