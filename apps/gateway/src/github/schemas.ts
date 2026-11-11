import { Schema } from "effect";

const positive = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);

export const DeviceResponse = Schema.Struct({
  device_code: Schema.NonEmptyString,
  user_code: Schema.NonEmptyString,
  verification_uri: Schema.Literal("https://github.com/login/device"),
  expires_in: positive,
  interval: positive,
});

export const OAuthError = Schema.Struct({ error: Schema.String });

export const TokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.NonEmptyString,
  expires_in: positive,
  refresh_token_expires_in: positive,
  token_type: Schema.String,
});

export const User = Schema.Struct({ id: positive, login: Schema.NonEmptyString });

export const Installation = Schema.Struct({
  id: positive,
  account: Schema.Struct({ login: Schema.NonEmptyString, type: Schema.String }),
  repository_selection: Schema.Literals(["all", "selected"]),
  permissions: Schema.Record(Schema.String, Schema.String),
  suspended_at: Schema.NullOr(Schema.String),
});

export const Installations = Schema.Struct({ total_count: Schema.Number, installations: Schema.Array(Installation) });

export const Repository = Schema.Struct({
  id: positive,
  full_name: Schema.NonEmptyString,
  private: Schema.Boolean,
  permissions: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
});

export const Repositories = Schema.Struct({ total_count: Schema.Number, repositories: Schema.Array(Repository) });

export type Installation = typeof Installation.Type;

export type Repository = typeof Repository.Type;
