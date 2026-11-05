import { toJson, type JsonValue } from "@bufbuild/protobuf";
import { bots, Provider } from "@canopy/contracts";
import { type JsonObject } from "@canopy/domain";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { Invalid, NotFound } from "../store/store.ts";
import { RequestExpired } from "../store/errors.ts";
import { proposedBot } from "./creation.ts";
import type { BotRow, BotTurn, ModelMessage, StoredCall, ToolResult, ToolSpec } from "./types.ts";
import { approvalView, botConfiguration, uuid, type ApprovalRow } from "./store-views.ts";
import type { BotCore } from "./store-queue.ts";

function requireWaitingHarness(sql: SqlClient.SqlClient, turnId: string) {
  return Effect.gen(function* () {
    const ended =
      yield* sql`SELECT turn_id FROM bot_harness_turns WHERE turn_id = ${turnId}::uuid AND outcome IS NOT NULL`;

    if (ended.length) return yield* Effect.fail(new RequestExpired());
  });
}

function startRemoteCall(sql: SqlClient.SqlClient, core: BotCore, turn: BotTurn, call: StoredCall, linked: boolean) {
  return sql.withTransaction(
    Effect.gen(function* () {
      yield* core.fenced(turn);
      yield* requireWaitingHarness(sql, turn.id);

      const started = yield* sql`UPDATE bot_tool_calls SET status = 'running', linked_remote = ${linked}
        WHERE id = ${call.id}::uuid AND status = 'pending' RETURNING id`;

      if (!started.length) return yield* Effect.fail(new RequestExpired());
    }),
  );
}

/** Running turns: leases, checkpoints and tool calls. */
export function botTurns(sql: SqlClient.SqlClient, core: BotCore) {
  const { owned, changed, active, fenced } = core;

  return {
    claim: (user: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          // Handoff is a configuration barrier ahead of queued work, but never preempts a live lease.
          const rows = yield* sql<BotRow & { next_turn_id: string }>`SELECT b.*, t.id AS next_turn_id FROM bots b
        CROSS JOIN LATERAL (SELECT * FROM bot_turns WHERE bot_id = b.id AND status IN ('queued','running','waiting')
          ORDER BY CASE WHEN status = 'running' AND lease_until > now() THEN 0 WHEN handoff_configuration IS NOT NULL THEN 1 ELSE 2 END, created_at, id LIMIT 1) t
        WHERE b.deleted_at IS NULL AND b.archived_at IS NULL AND b.owner_user_id = ${user}::uuid
          AND t.status IN ('queued','running') AND (t.lease_until IS NULL OR t.lease_until <= now())
        ORDER BY b.updated_at FOR UPDATE OF b SKIP LOCKED LIMIT 1`;

          if (!rows[0]) return undefined;
          const id = rows[0].id;
          const token = uuid();

          const turns =
            yield* sql<BotTurn>`UPDATE bot_turns SET status = 'running', lease_token = ${token}::uuid, lease_until = now() + interval '30 seconds'
        WHERE id = ${rows[0].next_turn_id}::uuid RETURNING *`;

          const turn = turns[0]!;
          // A remote side effect may already have happened. Never repeat it after a crash.
          yield* sql`UPDATE bot_tool_calls SET status = 'interrupted', result = '{"error":"interrupted: gateway restarted during remote call; outcome unknown; do not retry without user confirmation"}'::jsonb WHERE turn_id = ${turn.id}::uuid AND status = 'running' AND (tool ->> 'source' = 'mcp' OR linked_remote)`;
          yield* sql`UPDATE bots SET status_line = ${turn.routine_id || turn.handoff_configuration ? "" : "Typing…"}, revision = revision + 1 WHERE id = ${id}::uuid`;

          return turn;
        }),
      ),
    heartbeat: (turn: BotTurn) =>
      sql`UPDATE bot_turns SET lease_until = now() + interval '30 seconds' WHERE id = ${turn.id}::uuid AND lease_token = ${turn.lease_token}::uuid AND status = 'running' AND lease_until > now() RETURNING id`.pipe(
        Effect.map((r) => r.length > 0),
      ),
    status: (turn: BotTurn, text: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* fenced(turn);

          if (!turn.routine_id && !turn.handoff_configuration)
            yield* sql`UPDATE bots SET status_line = ${text}, revision = revision + 1 WHERE id = ${turn.bot_id}::uuid`;
        }),
      ),
    checkpoint: (turn: BotTurn, messages: ModelMessage[]) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* fenced(turn);
          yield* sql`UPDATE bot_turns SET checkpoint = ${JSON.stringify(messages)}::jsonb WHERE id = ${turn.id}::uuid`;
        }),
      ),
    planCall: (turn: BotTurn, callKey: string, tool: ToolSpec, args: JsonObject) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* fenced(turn);
          yield* sql`INSERT INTO bot_tool_calls(id, turn_id, call_key, tool, arguments) VALUES (${uuid()}::uuid, ${turn.id}::uuid, ${callKey}, ${JSON.stringify(tool)}::jsonb, ${JSON.stringify(args)}::jsonb) ON CONFLICT(turn_id, call_key) DO NOTHING`;

          return (yield* sql<StoredCall>`SELECT * FROM bot_tool_calls WHERE turn_id = ${turn.id}::uuid AND call_key = ${callKey}`)[0]!;
        }),
      ),
    call: (turn: BotTurn, id: string) =>
      sql<StoredCall>`SELECT * FROM bot_tool_calls WHERE id = ${id}::uuid AND turn_id = ${turn.id}::uuid`.pipe(
        Effect.map((r) => r[0]!),
      ),
    // A platform effect and its result commit together; the lease row is held until commit.
    action: <A, E, R>(turn: BotTurn, call: StoredCall, effect: Effect.Effect<A, E, R>) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* fenced(turn);

          const saved =
            (yield* sql<StoredCall>`SELECT * FROM bot_tool_calls WHERE id = ${call.id}::uuid FOR UPDATE`)[0]!;

          if (saved.status === "completed" || saved.status === "interrupted") {
            // SAFETY: a completed call stores this same action's earlier result (in its JSON form); a replay returns
            // it instead of running the action twice.
            return saved.result as A;
          }

          yield* requireWaitingHarness(sql, turn.id);

          const result = yield* effect;
          yield* sql`UPDATE bot_tool_calls SET status = 'completed', result = ${JSON.stringify(result ?? null)}::jsonb WHERE id = ${call.id}::uuid`;

          return result;
        }),
      ),
    remoteStarted: (turn: BotTurn, call: StoredCall, linked = false) => startRemoteCall(sql, core, turn, call, linked),
    remoteResult: (turn: BotTurn, call: StoredCall, result: ToolResult) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* fenced(turn);
          // A platform action may have committed before its post-commit dispatch failed.
          // Its durable result wins over a later transport error or stale executor result.
          yield* sql`UPDATE bot_tool_calls SET status = 'completed', result = ${JSON.stringify(result)}::jsonb WHERE id = ${call.id}::uuid AND status NOT IN ('completed','interrupted')`;

          return (yield* sql<StoredCall>`SELECT * FROM bot_tool_calls WHERE id = ${call.id}::uuid`)[0]!.result;
        }),
      ),
    interrupt: (user: string, id: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* owned(user, id, true);
          yield* sql`UPDATE bot_turns SET status = 'interrupted', lease_token = NULL, lease_until = NULL, finished_at = now() WHERE id = (SELECT id FROM bot_turns WHERE bot_id = ${id}::uuid AND handoff_configuration IS NULL AND status IN ('running','waiting','queued') ORDER BY created_at, id LIMIT 1)`;
          yield* sql`UPDATE bot_approvals SET status = 'expired', answered_at = now() WHERE bot_id = ${id}::uuid AND status = 'pending' AND turn_id IN (SELECT id FROM bot_turns WHERE status = 'interrupted')`;
          yield* sql`UPDATE bots SET status_line = '', revision = revision + 1 WHERE id = ${id}::uuid`;
        }),
      ),
    retry: (user: string, id: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* active(user, id, true);

          const last = (yield* sql<{
            id: string;
            status: string;
          }>`SELECT id, status FROM bot_turns WHERE bot_id = ${id}::uuid AND handoff_configuration IS NULL ORDER BY created_at DESC, id DESC LIMIT 1`)[0];

          if (last?.status !== "failed")
            return yield* Effect.fail(new Invalid("only a failed last reply can be retried"));
          // The failure note goes; the same input runs again from its checkpoint.
          yield* sql`DELETE FROM bot_messages WHERE turn_id = ${last.id}::uuid AND message_key = 'answer' AND kind = 'event'`;
          const harness = yield* sql`SELECT turn_id FROM bot_harness_turns WHERE turn_id = ${last.id}::uuid`;

          if (harness.length) {
            // An explicit retry is a new harness turn; the failed command and journal remain immutable audit.
            const next = uuid();
            yield* sql`INSERT INTO bot_turns(id, bot_id, client_request_id, input, hops, reply_to_bot_id, exchange_id, remote_recipient_ref, routine_id)
              SELECT ${next}::uuid, bot_id, ${`retry:${last.id}`}, input, hops, reply_to_bot_id, exchange_id, remote_recipient_ref, routine_id FROM bot_turns WHERE id = ${last.id}::uuid`;
            yield* sql`UPDATE bot_messages SET turn_id = ${next}::uuid WHERE turn_id = ${last.id}::uuid AND message_key = 'input'`;
          } else
            yield* sql`UPDATE bot_turns SET status = 'queued', finished_at = NULL, lease_token = NULL, lease_until = NULL WHERE id = ${last.id}::uuid`;
          yield* changed(id);
        }),
      ),
    release: (turn: BotTurn) =>
      sql`UPDATE bot_turns SET lease_until = now(), lease_token = NULL WHERE id = ${turn.id}::uuid AND lease_token = ${turn.lease_token}::uuid`,
  };
}

/** Approvals and questions a turn waits on. */
export function botApprovals(sql: SqlClient.SqlClient, core: BotCore) {
  const { owned, changed, fenced, validate, creationHop } = core;

  return {
    approval: (turn: BotTurn, call: StoredCall, prompt: string, question: boolean, expiresAt?: Date) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* fenced(turn);
          const previous = (yield* sql<ApprovalRow>`SELECT * FROM bot_approvals WHERE id = ${call.id}::uuid`)[0];

          if (previous) return approvalView(previous);

          const ended =
            yield* sql`SELECT turn_id FROM bot_harness_turns WHERE turn_id = ${turn.id}::uuid AND outcome IS NOT NULL`;

          const abandoned =
            yield* sql`SELECT id FROM bot_tool_calls WHERE id = ${call.id}::uuid AND status = 'interrupted'`;

          if (ended.length || abandoned.length) return yield* Effect.fail(new RequestExpired());
          let proposal: JsonValue | null = null;

          if (call.tool.source === "platform" && call.tool.name === "create_bot") {
            yield* creationHop(turn.hops);
            const creator = (yield* sql<BotRow>`SELECT * FROM bots WHERE id = ${turn.bot_id}::uuid`)[0]!;

            const draft = yield* Effect.try({
              try: () => proposedBot(call.arguments, botConfiguration(creator)),
              catch: (error) => (error instanceof Invalid ? error : new Invalid("invalid bot configuration")),
            });

            const config = yield* validate(creator.owner_user_id, draft, true);
            proposal = toJson(bots.BotConfigurationSchema, config);
            // Keep a prose fallback for clients predating the structured preview.
            prompt = [
              `Needs approval · Creating bot “${config.name}”`,
              `Name: ${config.name}`,
              `Model: ${config.model}`,
              `Effort: ${config.effort || "Model default"}`,
              `Instance: ${config.provider === Provider.CLAUDE ? "Claude" : "Codex"} · ${config.providerInstance}`,
              `Approval policy: ${config.approvalPolicy}`,
              `Instructions: ${config.instructions || "No additional instructions."}`,
            ].join("\n");
          }

          yield* sql`INSERT INTO bot_approvals(id, bot_id, turn_id, kind, prompt, proposed_bot, expires_at) VALUES (${call.id}::uuid, ${turn.bot_id}::uuid, ${turn.id}::uuid, ${question ? "question" : "approval"}, ${prompt}, ${JSON.stringify(proposal)}::jsonb, ${expiresAt ?? null}) ON CONFLICT(id) DO NOTHING`;

          return approvalView((yield* sql<ApprovalRow>`SELECT * FROM bot_approvals WHERE id = ${call.id}::uuid`)[0]!);
        }),
      ),
    wait: (turn: BotTurn) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* fenced(turn);

          // Serialize with answer(): an answer cannot arrive between this check and the wait state.
          const pending =
            yield* sql`SELECT id FROM bot_approvals WHERE turn_id = ${turn.id}::uuid AND status = 'pending' FOR UPDATE`;

          yield* sql`UPDATE bot_turns SET status = ${pending.length ? "waiting" : "queued"}, lease_token = NULL, lease_until = NULL WHERE id = ${turn.id}::uuid`;
          yield* sql`UPDATE bots SET status_line = ${pending.length ? "Waiting for you" : turn.routine_id ? "" : "Typing…"}, revision = revision + 1 WHERE id = ${turn.bot_id}::uuid`;
        }),
      ),
    answer: (user: string, request: bots.AnswerBotApprovalRequest) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const candidates =
            yield* sql<ApprovalRow>`SELECT a.* FROM bot_approvals a JOIN bots b ON b.id = a.bot_id WHERE a.id = ${request.approvalId}::uuid AND b.owner_user_id = ${user}::uuid AND b.deleted_at IS NULL`;

          if (!candidates[0]) return yield* Effect.fail(new NotFound("approval not found"));
          yield* owned(user, candidates[0].bot_id, true);

          // Same turn -> approval lock order as wait().
          const turns =
            yield* sql<BotTurn>`SELECT * FROM bot_turns WHERE id = ${candidates[0].turn_id}::uuid FOR UPDATE`;

          const row =
            (yield* sql<ApprovalRow>`SELECT * FROM bot_approvals WHERE id = ${request.approvalId}::uuid FOR UPDATE`)[0]!;

          if (row.status === "expired") return yield* Effect.fail(new RequestExpired());

          // A retried decision returns its durable result even after the turn finishes.
          if (row.status !== "pending") return approvalView(row);

          if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now())
            return yield* Effect.fail(new RequestExpired());

          if (!["running", "waiting", "queued"].includes(turns[0]!.status))
            return yield* Effect.fail(new RequestExpired());

          const ended =
            yield* sql`SELECT turn_id FROM bot_harness_turns WHERE turn_id = ${row.turn_id}::uuid AND outcome IS NOT NULL`;

          if (ended.length) return yield* Effect.fail(new RequestExpired());

          if (request.answer.length > 32_000) return yield* Effect.fail(new Invalid("answer too long"));

          const updated =
            (yield* sql<ApprovalRow>`UPDATE bot_approvals SET status = ${request.approve ? "approved" : "discarded"}, answer = ${request.answer}, answered_at = now() WHERE id = ${row.id}::uuid RETURNING *`)[0]!;

          yield* sql`UPDATE bot_turns SET status = 'queued' WHERE id = ${row.turn_id}::uuid AND status = 'waiting'`;
          yield* changed(row.bot_id);

          return approvalView(updated);
        }),
      ),
  };
}
