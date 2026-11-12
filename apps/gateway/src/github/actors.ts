import { Schema } from "effect";

export const actor = Schema.NullOr(
  Schema.Struct({
    login: Schema.String,
    id: Schema.optional(Schema.String),
    avatarUrl: Schema.optional(Schema.String),
    __typename: Schema.optional(Schema.String),
  }),
);

export const actorFields = "login avatarUrl(size:64) __typename";

export function actorLogin(value: typeof actor.Type, fallback = "Deleted user") {
  if (!value) return fallback;

  return value.__typename === "Bot" && !value.login.endsWith("[bot]") ? `${value.login}[bot]` : value.login;
}

export function actorAvatars(values: readonly (typeof actor.Type | undefined)[]) {
  const result: Record<string, string> = {};

  for (const value of values) if (value?.avatarUrl) result[actorLogin(value)] = value.avatarUrl;

  return result;
}
