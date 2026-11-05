import { create } from "@bufbuild/protobuf";
import { bots } from "@canopy/contracts";
import { connectorStore } from "../connectors/store.ts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { decryptSecret } from "../store/secrets.ts";
import { Invalid, NotFound } from "../store/store.ts";
import { handoffStore } from "./handoffs.ts";
import type { BotRow, BotTurn, McpConnection } from "./types.ts";
import { MOVE_RECONNECT } from "./store-views.ts";

/** Ownership, liveness and lease checks every bot operation starts from, and the bot's MCP connections. */
export function botAccess(sql: SqlClient.SqlClient, key: Buffer) {
  const handoffs = handoffStore(sql);

  const connections = connectorStore(sql, key);

  const owned = (user: string, id: string, lock = false) =>
    sql
      .unsafe<BotRow>(
        `SELECT b.*, (SELECT count(*) FROM bot_messages m WHERE m.bot_id = b.id AND m.seq > b.last_read_seq AND m.sender_id = b.id::text AND m.recipient_id = 'user' AND m.kind = 'message') AS unread_count,
      ${MOVE_RECONNECT} FROM bots b WHERE b.id = $1::uuid AND b.owner_user_id = $2::uuid AND b.deleted_at IS NULL${lock ? " FOR UPDATE OF b" : ""}`,
        [id, user],
      )
      .pipe(Effect.flatMap((rows) => (rows[0] ? Effect.succeed(rows[0]) : Effect.fail(new NotFound("bot not found")))));

  const changed = (id: string) =>
    sql`UPDATE bots SET revision = revision + 1, updated_at = now() WHERE id = ${id}::uuid`;

  const active = (user: string, id: string, lock = false) =>
    owned(user, id, lock).pipe(
      Effect.flatMap((row) =>
        row.archived_at
          ? Effect.fail(new Invalid("this bot is archived; unarchive it first"))
          : // Frozen for a move to another computer (docs/linked-computers.md, stage 8): nothing new starts here.
            row.moved_to
            ? Effect.fail(new Invalid("this bot is moving to another computer"))
            : Effect.succeed(row),
      ),
    );

  const unpin = (
    user: string,
    id: string,
  ) => sql`UPDATE user_settings SET settings = jsonb_set(settings, '{sidebar,pinnedBotIds}',
    coalesce((SELECT jsonb_agg(v) FROM jsonb_array_elements_text(settings #> '{sidebar,pinnedBotIds}') v WHERE v <> ${id}), '[]'::jsonb)),
    version = version + 1, updated_at = now() WHERE user_id = ${user}::uuid AND settings #> '{sidebar,pinnedBotIds}' ? ${id}`;

  const stopTurns = (id: string) =>
    Effect.gen(function* () {
      yield* sql`UPDATE bot_turns SET status = 'interrupted', finished_at = now(), lease_token = NULL, lease_until = NULL WHERE bot_id = ${id}::uuid AND status IN ('queued','running','waiting')`;
      yield* sql`UPDATE bot_approvals SET status = 'expired', answered_at = now() WHERE bot_id = ${id}::uuid AND status = 'pending'`;
      yield* sql`UPDATE bot_thread_watches SET delivered = true WHERE bot_id = ${id}::uuid AND NOT delivered`;
    });

  const fenced = (turn: BotTurn) =>
    Effect.gen(function* () {
      // Lifecycle operations and claim() lock bot -> turn. Writers must use that order too,
      // so an archive cannot deadlock with a checkpoint, self-edit or finishing response.
      const bot =
        yield* sql`SELECT id FROM bots WHERE id = ${turn.bot_id}::uuid AND deleted_at IS NULL AND archived_at IS NULL AND moved_to IS NULL FOR UPDATE`;

      if (!bot.length) return yield* Effect.fail(new Invalid("bot lease lost"));

      const rows =
        yield* sql<BotTurn>`SELECT * FROM bot_turns WHERE id = ${turn.id}::uuid AND lease_token = ${turn.lease_token}::uuid
      AND status = 'running' AND lease_until > now() FOR UPDATE`;

      return rows[0] ?? (yield* Effect.fail(new Invalid("bot lease lost")));
    });

  const secret = (user: string, id: string) =>
    sql<{
      ciphertext: Uint8Array;
    }>`SELECT ciphertext FROM secrets WHERE id = ${id}::uuid AND (owner_user_id = ${user}::uuid OR owner_user_id IS NULL)`.pipe(
      Effect.flatMap((r) =>
        r[0] ? Effect.succeed(decryptSecret(key, r[0].ciphertext)) : Effect.fail(new NotFound("secret not found")),
      ),
    );

  const server = (user: string, id: string) => connections.owned(user, id);

  const resolvedServer = (user: string, id: string) =>
    Effect.gen(function* () {
      const row = yield* server(user, id);
      const value = yield* connections.credentials(row);

      return { ...row, enabled: row.status === "connected", headers: value.headers ?? {} } satisfies McpConnection;
    });

  const servers = (user: string) =>
    Effect.gen(function* () {
      const rows = yield* connections.list(user);
      const result: bots.BotMcpServer[] = [];

      for (const row of rows.filter((r) => r.connector_type === "custom")) {
        const account = yield* connections.view(row);
        result.push(
          create(bots.BotMcpServerSchema, {
            id: row.id,
            name: row.name,
            url: row.url,
            transport: row.transport,
            enabled: row.status === "connected",
            headerNames: account.headerNames,
            botIds: account.botIds,
          }),
        );
      }

      return result;
    });

  return {
    handoffs,
    connections,
    owned,
    changed,
    active,
    unpin,
    stopTurns,
    fenced,
    secret,
    server,
    resolvedServer,
    servers,
  };
}

export type BotAccess = ReturnType<typeof botAccess>;
