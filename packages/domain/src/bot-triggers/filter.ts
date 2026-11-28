import { Option, Predicate, Schema } from "effect";
import type { JsonValue } from "../json.ts";
import { eventType, SCOPE_LABELS, type EventType, type FieldSpec, type ScopeKind } from "./catalog.ts";

export const MAX_SCOPE_IDS = 20;
export const COALESCE_SECONDS = { min: 30, max: 3600, default: 300 } as const;
export const TURNS_PER_HOUR = { min: 1, max: 12, default: 4 } as const;

export type FieldValue = string | number | boolean;

export interface Condition {
  eq?: FieldValue;
  in?: FieldValue[];
  gte?: number;
  lte?: number;
}

/** A trigger's filter as stored (`bot_routines.filter`) and returned to the bot. */
export interface TriggerFilter {
  scope: Partial<Record<ScopeKind, string[]>>;
  where: Record<string, Condition>;
  exclude_own: boolean;
  coalesce_seconds: number;
  max_turns_per_hour: number;
}

/** One event as the matcher sees it: its resources by kind and its field values. */
export interface EventFacts {
  scope: Partial<Record<ScopeKind, string>>;
  fields: Record<string, FieldValue | null>;
  /**
   * The previous observation of rising fields, for threshold crossings, with its time (`observed_at`, epoch
   * seconds).
   */
  previous?: Record<string, number | null>;
}

export class FilterProblem extends Error {}

const Value = Schema.Union([Schema.String, Schema.Number, Schema.Boolean]);

const Input = Schema.Struct({
  scope: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  where: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        eq: Schema.optionalKey(Value),
        in: Schema.optionalKey(Schema.Array(Value)),
        gte: Schema.optionalKey(Schema.Number),
        lte: Schema.optionalKey(Schema.Number),
      }),
    ),
  ),
  exclude_own: Schema.optionalKey(Schema.Boolean),
  coalesce_seconds: Schema.optionalKey(Schema.Number),
  max_turns_per_hour: Schema.optionalKey(Schema.Number),
});

const decode = Schema.decodeUnknownOption(Input);

function integer(value: number | undefined, range: { min: number; max: number; default: number }, name: string) {
  const v = value ?? range.default;

  if (!Number.isInteger(v) || v < range.min || v > range.max)
    throw new FilterProblem(`${name} must be a whole number from ${range.min} to ${range.max}`);

  return v;
}

function checkScope(type: EventType, input: Readonly<Record<string, readonly string[]>>) {
  const scope: Partial<Record<ScopeKind, string[]>> = {};
  let total = 0;

  for (const [kind, ids] of Object.entries(input)) {
    const scopeKind = type.scopeKinds.find((allowed) => allowed === kind);

    if (!scopeKind)
      throw new FilterProblem(`${type.name} cannot be scoped by ${kind}; use ${type.scopeKinds.join(", ")}`);

    const unique = [...new Set(ids.map((id) => id.trim()))];

    if (!unique.length || unique.some((id) => !id || id.length > 200))
      throw new FilterProblem(`scope.${kind} needs at least one valid id`);
    total += unique.length;
    scope[scopeKind] = unique;
  }

  if (total > MAX_SCOPE_IDS) throw new FilterProblem(`a trigger lists at most ${MAX_SCOPE_IDS} resources`);

  if (type.requiredAny.length && !type.requiredAny.some((kind) => scope[kind]?.length))
    throw new FilterProblem(`${type.name} needs a scope: ${type.requiredAny.join(" or ")} ids`);

  for (const kind of type.requiredAll)
    if (!scope[kind]?.length) throw new FilterProblem(`${type.name} needs scope.${kind}`);

  return scope;
}

function fits(spec: FieldSpec, value: FieldValue) {
  switch (spec.kind) {
    case "enum":
      return Predicate.isString(value) && spec.values.includes(value);
    case "number":
      return Predicate.isNumber(value) && Number.isFinite(value);
    case "boolean":
      return Predicate.isBoolean(value);
    case "string":
      return Predicate.isString(value) && value.length > 0 && value.length <= 200;
  }
}

function checkCondition(field: string, spec: FieldSpec, condition: Condition): Condition {
  const keys = Object.keys(condition);

  if (!keys.length) throw new FilterProblem(`where.${field} needs eq, in, gte or lte`);

  if ((condition.gte !== undefined || condition.lte !== undefined) && spec.kind !== "number")
    throw new FilterProblem(`where.${field} compares only with eq or in`);

  if (spec.kind === "number" && spec.crossing && (condition.gte === undefined || keys.length > 1))
    throw new FilterProblem(`where.${field} takes only a gte threshold: it matches when the value rises past it`);

  for (const value of [...(condition.eq === undefined ? [] : [condition.eq]), ...(condition.in ?? [])])
    if (!fits(spec, value))
      throw new FilterProblem(
        spec.kind === "enum"
          ? `where.${field} must be one of ${spec.values.join(", ")}`
          : `where.${field} must be a ${spec.kind}`,
      );

  if (condition.in && (!condition.in.length || condition.in.length > 20))
    throw new FilterProblem(`where.${field}.in needs 1 to 20 values`);

  return condition;
}

/** Validates a filter for an event type; throws FilterProblem with a message the bot can act on. */
export function parseTriggerFilter(event: string, input: JsonValue | TriggerFilter | undefined): TriggerFilter {
  const type = eventType(event);

  if (!type) throw new FilterProblem(`unknown event type ${event}`);
  const decoded = decode(input);

  if (Option.isNone(decoded)) throw new FilterProblem("filter needs scope (ids by kind) and optional where conditions");

  const where: Record<string, Condition> = {};

  for (const [field, condition] of Object.entries(decoded.value.where ?? {})) {
    const spec = type.fields[field];

    if (!spec) throw new FilterProblem(`${event} has no field ${field}`);
    const parsed: Condition = {};

    if (condition.eq !== undefined) parsed.eq = condition.eq;

    if (condition.in !== undefined) parsed.in = [...condition.in];

    if (condition.gte !== undefined) parsed.gte = condition.gte;

    if (condition.lte !== undefined) parsed.lte = condition.lte;
    where[field] = checkCondition(field, spec, parsed);
  }

  for (const field of type.requiredFields)
    if (!where[field]) throw new FilterProblem(`${event} needs a condition on ${field}`);

  return {
    scope: checkScope(type, decoded.value.scope),
    where,
    exclude_own: decoded.value.exclude_own ?? true,
    coalesce_seconds: integer(decoded.value.coalesce_seconds, COALESCE_SECONDS, "coalesce_seconds"),
    max_turns_per_hour: integer(decoded.value.max_turns_per_hour, TURNS_PER_HOUR, "max_turns_per_hour"),
  };
}

function holds(condition: Condition, value: FieldValue | null | undefined) {
  if (value === null || value === undefined) return false;

  if (condition.eq !== undefined && value !== condition.eq) return false;

  if (condition.in && !condition.in.includes(value)) return false;

  if (condition.gte !== undefined && !(Predicate.isNumber(value) && value >= condition.gte)) return false;

  return !(condition.lte !== undefined && !(Predicate.isNumber(value) && value <= condition.lte));
}

/**
 * A threshold on a rising field is crossed once: the previous observation was below it, and was made after the
 * trigger's current revision (`since`, epoch seconds), so a baseline from before the subscription never counts.
 */
function crossed(event: string | undefined, field: string, condition: Condition, facts: EventFacts, since = 0) {
  const spec = event ? eventType(event)?.fields[field] : undefined;

  if (condition.gte === undefined || spec?.kind !== "number" || !spec.crossing) return true;
  const previous = facts.previous?.[field];
  const observed = facts.previous?.["observed_at"];

  return Predicate.isNumber(previous) && previous < condition.gte && Predicate.isNumber(observed) && observed >= since;
}

/** Kinds in the scope combine with AND; ids within a kind with OR. Every condition must hold. */
export function matchesTrigger(filter: TriggerFilter, event: EventFacts, type?: string, since?: number): boolean {
  for (const [kind, ids] of Object.entries(filter.scope)) {
    // SAFETY: scope keys are scope kinds, validated when the filter was parsed.
    const id = event.scope[kind as ScopeKind];

    if (!id || !ids.includes(id)) return false;
  }

  return Object.entries(filter.where).every(
    ([field, condition]) => holds(condition, event.fields[field]) && crossed(type, field, condition, event, since),
  );
}

const listed = (values: readonly (string | number | boolean)[]) =>
  values.length > 1 ? `${values.slice(0, -1).join(", ")} or ${values.at(-1)}` : String(values[0]);

function describeCondition(spec: FieldSpec, condition: Condition) {
  const parts = [
    ...(condition.eq !== undefined ? [`is ${condition.eq}`] : []),
    ...(condition.in ? [`is ${listed(condition.in)}`] : []),
    ...(condition.gte !== undefined ? [`is at least ${condition.gte}`] : []),
    ...(condition.lte !== undefined ? [`is at most ${condition.lte}`] : []),
  ];

  return `${spec.label} ${parts.join(" and ")}`;
}

/** "When a thread turn finishes in project canopy, if status is failed; at most 4 runs an hour." */
export function describeTrigger(event: string, filter: TriggerFilter, names: Readonly<Record<string, string>> = {}) {
  const type = eventType(event);

  if (!type) return event;

  const scope = Object.entries(filter.scope).map(
    // SAFETY: scope keys are scope kinds, validated when the filter was parsed.
    ([kind, ids]) => `${SCOPE_LABELS[kind as ScopeKind]} ${listed(ids.map((id) => names[id] ?? id))}`,
  );

  const conditions = Object.entries(filter.where).map(([field, condition]) =>
    describeCondition(type.fields[field]!, condition),
  );

  const when = `When ${type.label}${scope.length ? ` in ${scope.join(" and ")}` : ""}`;
  const runs = filter.max_turns_per_hour === 1 ? "1 run" : `${filter.max_turns_per_hour} runs`;

  return `${when}${conditions.length ? `, if ${conditions.join(" and ")}` : ""}; at most ${runs} an hour`;
}
