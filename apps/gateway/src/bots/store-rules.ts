import { create, fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { bots } from "@canopy/contracts";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { Invalid, NotFound } from "../store/store.ts";
import type { BotCore } from "./store-queue.ts";
import { matchesRule, ruleOptions } from "./approval-rules.ts";
import type { StoredCall } from "./types.ts";

interface RuleRow {
  id: string;
  bot_id: string;
  kind: string;
  target_id: string;
  tool_name: string;
  label: string;
  source: string;
  created_at: Date;
}

const ruleView = (r: RuleRow) =>
  create(bots.BotApprovalRuleSchema, {
    id: r.id,
    botId: r.bot_id,
    kind: r.kind,
    targetId: r.target_id,
    toolName: r.tool_name,
    label: r.label,
    source: r.source,
    createdAt: timestampFromDate(new Date(r.created_at)),
  });

export const decodedRules = (values: JsonValue[] = []) => values.map((v) => fromJson(bots.BotApprovalRuleSchema, v));

/** Stored separately from configuration: no model-facing write path accepts rules. */
export function botRules(sql: SqlClient.SqlClient, core: BotCore) {
  const list = (user: string, botId: string) =>
    Effect.gen(function* () {
      yield* core.owned(user, botId);

      const rows = yield* sql<RuleRow>`SELECT * FROM bot_approval_rules
      WHERE owner_user_id = ${user}::uuid AND bot_id = ${botId}::uuid AND revoked_at IS NULL ORDER BY created_at, id`;

      return rows.map(ruleView);
    });

  return {
    rules: list,
    deleteRule: (user: string, botId: string, ruleId: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          if (![botId, ruleId].every((id) => Schema.is(Schema.String.check(Schema.isUUID()))(id)))
            return yield* Effect.fail(new Invalid("Choose a valid bot and approval rule."));
          yield* core.owned(user, botId, true);

          const changed = yield* sql`UPDATE bot_approval_rules SET revoked_at = coalesce(revoked_at, now())
        WHERE id = ${ruleId}::uuid AND bot_id = ${botId}::uuid AND owner_user_id = ${user}::uuid RETURNING id`;

          if (!changed.length) return yield* Effect.fail(new NotFound("approval rule not found"));
          yield* core.changed(botId);
        }),
      ),
    matchingRule: (user: string, botId: string, call: StoredCall, phrase: string) =>
      Effect.gen(function* () {
        const options = ruleOptions(call.tool, call.arguments, phrase);
        const bot = yield* core.owned(user, botId);

        if (!options.length || bot.archived_at || bot.moved_to) return { options, matched: undefined };
        const rules = yield* list(user, botId);

        return { options, matched: rules.find((r) => options.some((o) => matchesRule(r, o))) };
      }),
    saveCardRule: (user: string, botId: string, options: JsonValue[], optionId: string) =>
      Effect.gen(function* () {
        const option = decodedRules(options).find((o) => o.id === optionId);

        if (!option) return yield* Effect.fail(new Invalid("Choose an allowed action shown on this request."));
        yield* sql`INSERT INTO bot_approval_rules(id, owner_user_id, bot_id, kind, target_id, tool_name, label, source)
        VALUES (${option.id}::uuid, ${user}::uuid, ${botId}::uuid, ${option.kind}, ${option.targetId}, ${option.toolName}, ${option.label}, 'approval_card')
        ON CONFLICT(bot_id, kind, target_id, tool_name) WHERE revoked_at IS NULL DO NOTHING`;
        const saved = (yield* list(user, botId)).find((r) => matchesRule(r, option));

        return saved ? toJson(bots.BotApprovalRuleSchema, saved) : null;
      }),
  };
}
