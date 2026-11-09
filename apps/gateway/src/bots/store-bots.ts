import { create, fromJson } from "@bufbuild/protobuf";
import { bots, Provider } from "@canopy/contracts";
import { Effect, Predicate } from "effect";
import { SqlClient } from "effect/sql";
import { Invalid } from "../store/store.ts";
import { harnessOf, providerOf, type InstanceRow } from "../store/instance-config.ts";
import type { BotRow, BotTurn, StoredCall } from "./types.ts";
import {
  MOVE_RECONNECT,
  botConfiguration,
  approvalView,
  botView,
  messageView,
  uuid,
  type ApprovalRow,
  type MessageRow,
} from "./store-views.ts";
import type { BotCore } from "./store-queue.ts";
import { botThreadApprovals } from "./thread-approvals.ts";

/** Bots: handoffs, models, lifecycle and creation by another bot. */
export function botMethods(sql: SqlClient.SqlClient, core: BotCore) {
  const { owned, active, unpin, stopTurns, fenced, catalogs, save, creationHop } = core;

  return {
    finishHandoff: (turn: BotTurn, model: string, note: string, reason = "") =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* fenced(turn);
          yield* sql`INSERT INTO bot_handoff_notes(turn_id, bot_id, model, note, fallback_reason) VALUES (${turn.id}::uuid, ${turn.bot_id}::uuid, ${model}, ${note.slice(0, 32000)}, ${reason}) ON CONFLICT(turn_id) DO NOTHING`;
          yield* sql`UPDATE bot_turns SET status = 'completed', finished_at = now(), lease_token = NULL, lease_until = NULL WHERE id = ${turn.id}::uuid`;
          yield* sql`UPDATE bots SET status_line = '', revision = revision + 1 WHERE id = ${turn.bot_id}::uuid`;
        }),
      ),
    instanceLabel: (config: bots.BotConfiguration) =>
      sql<{
        label: string;
      }>`SELECT label FROM provider_instances WHERE harness = ${harnessOf(config.provider)} AND id = ${config.providerInstance}`.pipe(
        Effect.flatMap((rows) =>
          rows[0]
            ? Effect.succeed(rows[0].label || config.providerInstance)
            : Effect.fail(new Invalid("Bot provider instance is unavailable")),
        ),
      ),
    harnessModels: (user: string, provider: Provider, instanceId: string, workerId = "") =>
      Effect.gen(function* () {
        const instance = (yield* sql<Pick<InstanceRow, "custom_models">>`SELECT custom_models FROM provider_instances
            WHERE harness = ${harnessOf(provider)} AND id = ${instanceId}
              AND (created_by=${user}::uuid OR created_by IS NULL)`)[0];

        if (!instance) return yield* Effect.fail(new Invalid("choose an existing provider instance"));

        const profiles = yield* catalogs(
          user,
          create(bots.BotConfigurationSchema, { provider, providerInstance: instanceId, workerId }),
        );

        const models = profiles
          .flatMap((p) => p.models)
          .filter((m) => !m.hidden)
          .map((m) => ({
            id: m.id,
            name: m.displayName || m.id,
            default: m.isDefault,
            efforts: m.efforts,
            default_effort: m.defaultEffort,
          }));

        for (const id of instance.custom_models)
          if (!models.some((m) => m.id === id))
            models.push({ id, name: id, default: false, efforts: [], default_effort: "" });

        return [...new Map(models.map((m) => [m.id, m])).values()];
      }),
    archive: (user: string, id: string, archived: boolean) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* owned(user, id, true);

          const row =
            (yield* sql<BotRow>`UPDATE bots SET archived_at = ${archived ? new Date() : null}, status_line = '', revision = revision + 1, updated_at = now() WHERE id = ${id}::uuid RETURNING *`)[0]!;

          if (archived) {
            yield* stopTurns(id);
            yield* unpin(user, id);
          }

          return botView(row);
        }),
      ),
    createFromBot: (user: string, turn: BotTurn, call: StoredCall) =>
      Effect.gen(function* () {
        yield* creationHop(turn.hops);
        const creator = yield* active(user, turn.bot_id);

        const approved =
          (yield* sql<ApprovalRow>`SELECT * FROM bot_approvals WHERE id = ${call.id}::uuid AND bot_id = ${turn.bot_id}::uuid AND turn_id = ${turn.id}::uuid AND status = 'approved'`)[0];

        const proposal = approved?.proposed_bot
          ? fromJson(bots.BotConfigurationSchema, approved.proposed_bot)
          : undefined;

        if (!proposal)
          return yield* Effect.fail(new Invalid("creating a bot requires user approval of its configuration"));
        const saved = yield* save(user, proposal, { requestId: call.id });
        yield* sql`UPDATE bots SET created_by_bot_id = ${creator.id}::uuid, created_by_bot_name = ${botConfiguration(creator).name} WHERE id = ${saved.id}::uuid`;

        return { id: saved.id, name: saved.configuration!.name };
      }),
    list: (user: string, includeArchived = false) =>
      Effect.gen(function* () {
        const rows = yield* sql.unsafe<BotRow>(
          `SELECT b.*, (SELECT count(*) FROM bot_messages m WHERE m.bot_id = b.id AND m.seq > b.last_read_seq AND m.sender_id = b.id::text AND m.recipient_id = 'user' AND m.kind = 'message') AS unread_count,
        ${MOVE_RECONNECT} FROM bots b WHERE b.owner_user_id = $1::uuid AND b.deleted_at IS NULL AND ($2 OR b.archived_at IS NULL) ORDER BY b.created_at, b.id`,
          [user, includeArchived],
        );

        const latest =
          yield* sql<MessageRow>`SELECT DISTINCT ON(m.bot_id) m.*, t.status AS turn_status FROM bot_messages m JOIN bots b ON b.id = m.bot_id JOIN bot_turns t ON t.id = m.turn_id
        WHERE b.owner_user_id = ${user}::uuid AND b.deleted_at IS NULL ORDER BY m.bot_id, m.seq DESC`;

        // Notifications: the newest card waiting for the owner, without its fields or proposal.
        const pending =
          yield* sql<ApprovalRow>`SELECT DISTINCT ON(a.bot_id) a.id, a.bot_id, a.turn_id, a.kind, left(a.prompt, 2000) AS prompt, a.status, '' AS answer,
          a.created_at, a.expires_at, t.routine_title, NULL AS proposed_bot
        FROM bot_approvals a JOIN bots b ON b.id = a.bot_id JOIN bot_turns t ON t.id = a.turn_id
        WHERE b.owner_user_id = ${user}::uuid AND b.deleted_at IS NULL AND a.status = 'pending' ORDER BY a.bot_id, a.created_at DESC, a.id DESC`;

        const byBot = new Map(latest.map((m) => [m.bot_id, messageView(m)]));
        const waiting = new Map(pending.map((a) => [a.bot_id, approvalView(a)]));

        for (const card of yield* botThreadApprovals(sql).threadApprovals(user, "", true))
          if (card.status === "pending" && !waiting.has(card.botId)) waiting.set(card.botId, card);

        return rows.map((r) =>
          create(bots.BotSchema, { ...botView(r), lastMessage: byBot.get(r.id), pendingApproval: waiting.get(r.id) }),
        );
      }),
    remove: (user: string, id: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* owned(user, id, true);
          yield* sql`UPDATE bots SET deleted_at = now(), status_line = '', revision = revision + 1 WHERE id = ${id}::uuid`;
          yield* stopTurns(id);
          yield* unpin(user, id);
          yield* sql`UPDATE bot_wakeups SET cancelled = true WHERE bot_id = ${id}::uuid`;
        }),
      ),
  };
}

/** A bot editing its own configuration (update_self). */
export function botSelfUpdate(sql: SqlClient.SqlClient, core: BotCore) {
  const { owned, save } = core;

  return {
    updateSelf: (user: string, turn: BotTurn, call: StoredCall) =>
      Effect.gen(function* () {
        const args = call.arguments;

        const fields = {
          name: "name",
          shape: "shape",
          color: "color",
          instructions: "instructions",
          model: "model",
          effort: "effort",
          provider_instance: "providerInstance",
          approval_policy: "approvalPolicy",
        } as const;

        const allowed = [...Object.keys(fields), "provider", "append_instructions"];
        const given = new Map<string, string>();

        for (const [key, value] of Object.entries(args))
          if (allowed.includes(key) && Predicate.isString(value)) given.set(key, value);

        if (!given.size || given.size !== Object.keys(args).length)
          return yield* Effect.fail(new Invalid("update_self accepts only your own supported setting fields"));

        if (Object.hasOwn(args, "instructions") && Object.hasOwn(args, "append_instructions"))
          return yield* Effect.fail(new Invalid("use instructions or append_instructions, not both"));

        if (
          ["model", "effort", "provider", "provider_instance", "approval_policy"].some((k) => Object.hasOwn(args, k))
        ) {
          const approved =
            yield* sql`SELECT id FROM bot_approvals WHERE id = ${call.id}::uuid AND bot_id = ${turn.bot_id}::uuid AND turn_id = ${turn.id}::uuid AND status = 'approved'`;

          if (!approved.length)
            return yield* Effect.fail(new Invalid("changing model, effort or approval policy requires user approval"));
        }

        const row = yield* owned(user, turn.bot_id, true);
        const before = botConfiguration(row);
        const next = create(bots.BotConfigurationSchema, { ...before });

        for (const [arg, field] of Object.entries(fields)) {
          const value = given.get(arg);

          if (value !== undefined) next[field] = value;
        }

        const provider = given.get("provider");
        const appended = given.get("append_instructions");

        if (provider !== undefined) {
          if (!["claude", "codex", "grok"].includes(provider))
            return yield* Effect.fail(new Invalid("unknown provider"));
          next.provider = providerOf(provider);
        }

        if (appended !== undefined) next.instructions = [before.instructions, appended].filter(Boolean).join("\n");
        const saved = (yield* save(user, next, { id: turn.bot_id })).configuration!;

        const labels = [
          ["name", "name"],
          ["shape", "shape"],
          ["color", "colour"],
          ["instructions", "instructions"],
          ["model", "model"],
          ["effort", "reasoning effort"],
          ["providerInstance", "provider instance"],
          ["approvalPolicy", "approval policy"],
          ["provider", "provider"],
        ] as const satisfies readonly (readonly [keyof bots.BotConfiguration, string])[];

        const changes = labels.flatMap(([field, label]) => {
          const previous = String(before[field] ?? "");
          const after = String(saved[field] ?? "");

          return previous === after ? [] : [{ field: label, before: previous, after }];
        });

        const text = changes
          .map((c) =>
            c.field === "name"
              ? `${before.name} changed its name to ${c.after}`
              : `${saved.name} updated its ${c.field}`,
          )
          .join(". ");

        if (changes.length)
          yield* sql`INSERT INTO bot_messages(id, bot_id, turn_id, message_key, sender_id, recipient_id, kind, text)
        VALUES (${uuid()}::uuid, ${turn.bot_id}::uuid, ${turn.id}::uuid, ${`self:${call.id}`}, 'self', 'user', 'event', ${text})
        ON CONFLICT(turn_id, message_key) DO NOTHING`;

        return { updated: true, changes };
      }),
  };
}
