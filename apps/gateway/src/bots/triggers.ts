import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { bots } from "@canopy/contracts";
import { describeTrigger, FilterProblem, parseTriggerFilter, type TriggerFilter } from "@canopy/domain/bot-triggers";
import type { JsonValue } from "@canopy/domain";
import { Effect } from "effect";
import type { SqlClient, SqlError } from "effect/sql";
import { Invalid, NotFound } from "../store/store.ts";
import { lockedOwnerModule, moduleDisabledMessage } from "../store/module-access.ts";
import { nextHop } from "./policy.ts";
import { stopRoutine } from "./routines.ts";
import { checkTriggerScope, writeTriggerScopes } from "./trigger-scopes.ts";
import type { BotRow, BotTurn } from "./types.ts";

export const TRIGGER_LIMIT = 20;

export interface TriggerRow {
  id: string;
  bot_id: string;
  title: string;
  instructions: string;
  event: string;
  filter: TriggerFilter;
  schedule_text: string;
  revision: number;
  enabled: boolean;
  auto_paused: boolean;
  hops: number;
  created_at: Date;
  updated_at: Date;
  last_run_at: Date | null;
  last_outcome: string;
  run_count: number;
  matched_week?: number;
  runs_week?: number;
}

export interface TriggerInput {
  title?: string;
  instructions?: string;
  event?: string;
  filter?: JsonValue | TriggerFilter;
  enabled?: boolean;
}

type Fx<A> = Effect.Effect<A, SqlError.SqlError | Invalid | NotFound>;

interface Hooks {
  owned(user: string, botId: string, lock?: boolean): Fx<BotRow>;
  changed(botId: string): Fx<unknown>;
}

const at = (date: Date | null) => (date ? timestampFromDate(new Date(date)) : undefined);

export const triggerView = (r: TriggerRow) =>
  create(bots.BotTriggerSchema, {
    id: r.id,
    botId: r.bot_id,
    title: r.title,
    instructions: r.instructions,
    event: r.event,
    filterJson: JSON.stringify(r.filter),
    description: r.schedule_text,
    revision: r.revision,
    enabled: r.enabled,
    autoPaused: r.auto_paused,
    createdAt: at(r.created_at),
    updatedAt: at(r.updated_at),
    lastRunAt: at(r.last_run_at),
    lastOutcome: r.last_outcome,
    runCount: r.run_count,
    matchedWeek: Number(r.matched_week ?? 0),
    runsWeek: Number(r.runs_week ?? 0),
  });

function text(value: string | undefined, name: string, limit: number) {
  const trimmed = value?.trim() ?? "";

  // oxlint-disable-next-line no-control-regex -- a title is one line of visible text
  if (!trimmed || trimmed.length > limit || (name === "title" && /[\x00-\x1f]/.test(trimmed)))
    throw new Invalid(`${name} is required (at most ${limit} characters${name === "title" ? ", one line" : ""})`);

  return trimmed;
}

/** Title, instructions and a filter that is valid for its event and lists only the owner's live resources. */
function checked(sql: SqlClient.SqlClient, owner: string, input: Required<Omit<TriggerInput, "enabled">>) {
  return Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => ({
        title: text(input.title, "title", 120),
        instructions: text(input.instructions, "instructions", 32_000),
        filter: parseTriggerFilter(input.event, input.filter),
      }),
      catch: (e) =>
        e instanceof Invalid ? e : new Invalid(e instanceof FilterProblem ? e.message : "invalid trigger filter"),
    });

    const names = yield* checkTriggerScope(sql, owner, parsed.filter);

    return { ...parsed, event: input.event, description: describeTrigger(input.event, parsed.filter, names) };
  });
}

const SELECT = `r.*, (SELECT coalesce(sum(matched), 0)::int FROM bot_trigger_batches x
    WHERE x.trigger_id = r.id AND (x.status = 'open' OR x.closed_at > now() - interval '7 days')) AS matched_week,
  (SELECT count(*)::int FROM bot_turns t WHERE t.routine_id = r.id AND t.created_at > now() - interval '7 days') AS runs_week`;

/** Bot-owned event triggers: `bot_routines` rows of kind 'trigger'. Lock order: bot -> trigger -> turn. */
export function triggerStore(sql: SqlClient.SqlClient, hooks: Hooks) {
  const rows = (botId: string) =>
    sql<TriggerRow>`SELECT ${sql.literal(SELECT)} FROM bot_routines r
      WHERE r.bot_id = ${botId}::uuid AND r.kind = 'trigger' AND r.deleted_at IS NULL ORDER BY r.created_at, r.id`;

  const get = (botId: string, id: string) =>
    sql<TriggerRow>`SELECT ${sql.literal(SELECT)} FROM bot_routines r WHERE r.id = ${id}::uuid
      AND r.bot_id = ${botId}::uuid AND r.kind = 'trigger' AND r.deleted_at IS NULL`.pipe(
      Effect.flatMap((r) => (r[0] ? Effect.succeed(r[0]) : Effect.fail(new NotFound("trigger not found")))),
    );

  // Batches of an earlier revision never mix an old filter with new instructions.
  const dropBatches = (id: string, reason: string) =>
    sql`UPDATE bot_trigger_batches SET status = 'dropped', reason = ${reason}, closed_at = now()
      WHERE trigger_id = ${id}::uuid AND status = 'open'`;

  const update = (user: string, botId: string, id: string, patch: TriggerInput, revision?: number) =>
    sql.withTransaction(
      Effect.gen(function* () {
        if (patch.enabled && !(yield* lockedOwnerModule(sql, user, "bots")))
          return yield* Effect.fail(new Invalid(moduleDisabledMessage("bots")));
        yield* hooks.owned(user, botId, true);
        const old = yield* get(botId, id);

        if (revision !== undefined && revision !== old.revision)
          return yield* Effect.fail(new Invalid("The trigger changed meanwhile. Read it again and resend."));

        const enabled = patch.enabled ?? old.enabled;

        const input = {
          title: patch.title ?? old.title,
          instructions: patch.instructions ?? old.instructions,
          event: patch.event ?? old.event,
          filter: patch.filter ?? old.filter,
        };

        // Turning a trigger off always works, even after its resources are gone.
        const c =
          enabled || patch.filter !== undefined || patch.event !== undefined
            ? yield* checked(sql, user, input)
            : yield* Effect.try({
                try: () => ({
                  title: text(input.title, "title", 120),
                  instructions: text(input.instructions, "instructions", 32_000),
                  event: input.event,
                  filter: old.filter,
                  description: old.schedule_text,
                }),
                catch: (e) => (e instanceof Invalid ? e : new Invalid("invalid trigger")),
              });

        // Only an explicit request resumes a trigger, also after an automatic pause; other edits keep it paused.
        const resumed = patch.enabled === true && (!old.enabled || old.auto_paused);

        yield* sql`UPDATE bot_routines SET title = ${c.title}, instructions = ${c.instructions}, event = ${c.event},
          filter = ${JSON.stringify(c.filter)}::jsonb, schedule_text = ${c.description}, enabled = ${enabled},
          auto_paused = auto_paused AND NOT ${resumed}, limit_hits = CASE WHEN ${resumed} THEN 0 ELSE limit_hits END,
          revision = revision + 1, updated_at = now() WHERE id = ${id}::uuid`;
        yield* dropBatches(id, "Trigger changed");
        yield* writeTriggerScopes(sql, user, {
          id,
          event: c.event,
          filter: c.filter,
          live: enabled && (resumed || !old.auto_paused),
        });

        if (!enabled) yield* stopRoutine(sql, id);
        yield* hooks.changed(botId);

        return triggerView(yield* get(botId, id));
      }),
    );

  return {
    routineKind: (id: string) =>
      sql<{ kind: string }>`SELECT kind FROM bot_routines WHERE id = ${id}::uuid`.pipe(
        Effect.map((rows) => rows[0]?.kind ?? "routine"),
      ),
    triggers: (user: string, botId: string) =>
      Effect.gen(function* () {
        yield* hooks.owned(user, botId);

        return (yield* rows(botId)).map(triggerView);
      }),
    trigger: (user: string, botId: string, id: string) =>
      Effect.gen(function* () {
        yield* hooks.owned(user, botId);

        return triggerView(yield* get(botId, id));
      }),
    createTrigger: (user: string, turn: BotTurn, id: string, input: TriggerInput) =>
      Effect.gen(function* () {
        yield* hooks.owned(user, turn.bot_id, true);

        if ((yield* rows(turn.bot_id)).length >= TRIGGER_LIMIT)
          return yield* Effect.fail(new Invalid(`at most ${TRIGGER_LIMIT} event triggers per bot`));

        const c = yield* checked(sql, user, {
          title: input.title ?? "",
          instructions: input.instructions ?? "",
          event: input.event ?? "",
          filter: input.filter ?? null,
        });

        const hops = yield* Effect.try({
          try: () => nextHop(turn.hops),
          catch: (error) => (error instanceof Invalid ? error : new Invalid("Invalid message counter.")),
        });

        yield* sql`INSERT INTO bot_routines(id, bot_id, kind, title, instructions, cron, timezone, schedule_text,
            next_run_at, hops, event, filter)
          VALUES (${id}::uuid, ${turn.bot_id}::uuid, 'trigger', ${c.title}, ${c.instructions}, NULL, 'UTC',
            ${c.description}, NULL, ${hops}, ${c.event}, ${JSON.stringify(c.filter)}::jsonb)`;
        yield* writeTriggerScopes(sql, user, { id, event: c.event, filter: c.filter, live: true });
        yield* hooks.changed(turn.bot_id);

        return triggerView(yield* get(turn.bot_id, id));
      }),
    updateTrigger: update,
    deleteTrigger: (user: string, botId: string, id: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* hooks.owned(user, botId, true);
          yield* get(botId, id);
          yield* sql`UPDATE bot_routines SET deleted_at = now(), updated_at = now(), enabled = false,
            revision = revision + 1 WHERE id = ${id}::uuid`;
          yield* sql`DELETE FROM bot_trigger_scopes WHERE trigger_id = ${id}::uuid`;
          yield* dropBatches(id, "Trigger deleted");
          yield* stopRoutine(sql, id);
          yield* hooks.changed(botId);

          return { deleted: true };
        }),
      ),
  };
}
