import { fromBinary, fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { CommandSchema, Provider, ui, UsageScope, type Usage, type ThreadEvent } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { counterDelta, usageTotals, COUNT_FIELDS, COST_FIELDS, TOKEN_FIELDS } from "./totals.ts";
import { freezeRequestedTier, validRequestedTier } from "./speed.ts";
import { lockUsageOwner, incrementBucket } from "./storage.ts";

export interface UsageIdentity {
  owner: string;
  subject: string;
  counter: string;
  provider: string;
  model: string;
  requestedServiceTier?: string;
  threadId?: string;
  botId?: string;
}

/** Runs inside the event/command transaction, before the durable acknowledgement. */
export function recordUsage(sql: SqlClient.SqlClient, identity: UsageIdentity, usage: Usage, observedAt: Date) {
  return Effect.gen(function* () {
    if (usage.scope !== UsageScope.TURN) return;
    const { owner, subject, counter, provider } = identity;
    const model = usage.model || identity.model;
    yield* lockUsageOwner(sql, owner);

    const requestedTier = yield* freezeRequestedTier(
      sql,
      identity,
      validRequestedTier(usage.requestedServiceTier) || validRequestedTier(identity.requestedServiceTier),
    );

    const old = (yield* sql<{
      totals: JsonValue;
      first_bucket: Date;
      pricing_version: string;
    }>`SELECT totals,first_bucket,pricing_version FROM usage_counters
      WHERE owner_user_id=${owner}::uuid AND subject_id=${subject} AND provider=${provider}
        AND model=${model} AND counter_id=${counter}`)[0];

    const previous = old ? fromJson(ui.UsageTotalsSchema, old.totals) : undefined;
    const incoming = usageTotals(usage);
    const { next, delta } = counterDelta(previous, incoming);

    const pricingVersion =
      next.unknownEstimatedCostReports === 0n &&
      usage.estimatedCostUsd === next.estimatedCostUsd &&
      TOKEN_FIELDS.every((field) => incoming[field] >= next[field]) &&
      usage.pricingVersion.length <= 65_536 &&
      !usage.pricingVersion.includes("\u0000")
        ? usage.pricingVersion || old?.pricing_version || ""
        : old?.pricing_version || "";

    if (
      !COUNT_FIELDS.some((field) => delta[field] !== 0n) &&
      !COST_FIELDS.some((field) => delta[field] !== 0) &&
      pricingVersion === (old?.pricing_version ?? "")
    )
      return;
    const hour = old?.first_bucket ?? new Date(Math.floor(observedAt.getTime() / 3_600_000) * 3_600_000);
    // A turn/model stays in its first observed hour, including delayed corrections. Subset counters
    // therefore remain subsets of the same bucket even when fields arrive at different times.
    yield* incrementBucket(sql, owner, hour, provider, model, requestedTier, delta);
    yield* sql`INSERT INTO usage_counters(owner_user_id,subject_id,thread_id,bot_id,thread_turn_id,bot_turn_id,provider,model,requested_service_tier,counter_id,first_bucket,totals,pricing_version)
      VALUES(${owner}::uuid,${subject},${identity.threadId ?? null}::uuid,${identity.botId ?? null}::uuid,
        ${identity.threadId ? counter : null}::uuid,${identity.botId ? counter : null}::uuid,${provider},${model},${requestedTier},${counter},${hour},${JSON.stringify(toJson(ui.UsageTotalsSchema, next))}::jsonb,${pricingVersion})
      ON CONFLICT(owner_user_id,subject_id,provider,model,counter_id) DO UPDATE SET totals=excluded.totals,requested_service_tier=excluded.requested_service_tier,pricing_version=excluded.pricing_version`;
  });
}

export function eventUsage(event: ThreadEvent): Usage | undefined {
  const body = event.body;

  return body.case === "usageUpdated" || body.case === "turnFinished" ? body.value.usage : undefined;
}

/** Only existing local turns count: imports, mirrors and fork history cannot manufacture usage. */
export function accountThreadUsage(sql: SqlClient.SqlClient, threadId: string, event: ThreadEvent) {
  return Effect.gen(function* () {
    const usage = eventUsage(event);

    if (!usage || usage.scope !== UsageScope.TURN || !event.turnId) return;

    const row = (yield* sql<{ owner_user_id: string; provider: string; model: string; service_tier: string }>`
      SELECT t.owner_user_id,t.provider,u.model,u.service_tier FROM threads t JOIN turns u ON u.thread_id=t.id
      WHERE t.id=${threadId}::uuid AND u.id=${event.turnId}::uuid`)[0];

    if (!row) return;
    yield* recordUsage(
      sql,
      {
        owner: row.owner_user_id,
        subject: `thread:${threadId}`,
        counter: event.turnId,
        provider: row.provider,
        model: row.model,
        requestedServiceTier: row.service_tier,
        threadId,
      },
      usage,
      event.occurredAt ? timestampDate(event.occurredAt) : new Date(),
    );
  });
}

export function accountBotUsage(sql: SqlClient.SqlClient, botId: string, event: ThreadEvent) {
  return Effect.gen(function* () {
    const usage = eventUsage(event);

    if (!usage || usage.scope !== UsageScope.TURN || !event.turnId) return;

    const row = (yield* sql<{ owner_user_id: string; payload: Uint8Array }>`
      SELECT b.owner_user_id,c.payload
      FROM bots b JOIN bot_harness_turns h ON h.bot_id=b.id JOIN worker_commands c ON c.id=h.command_id
      WHERE b.id=${botId}::uuid AND h.turn_id=${event.turnId}::uuid`)[0];

    if (!row) return;
    const command = fromBinary(CommandSchema, row.payload);

    if (command.kind.case !== "runBotTurn") return;
    const input = command.kind.value;

    const provider =
      input.provider === Provider.CLAUDE ? "claude" : input.provider === Provider.CODEX ? "codex" : "grok";

    yield* recordUsage(
      sql,
      {
        owner: row.owner_user_id,
        subject: `bot:${botId}`,
        counter: event.turnId,
        provider,
        model: input.model,
        requestedServiceTier: input.serviceTier,
        botId,
      },
      usage,
      event.occurredAt ? timestampDate(event.occurredAt) : new Date(),
    );
  });
}
