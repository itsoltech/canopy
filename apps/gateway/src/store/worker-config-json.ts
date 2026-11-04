import { Schema } from "effect";

const Rest = [Schema.Record(Schema.String, Schema.Json)] as const;

const StoredEnv = Schema.StructWithRest(
  Schema.Struct({ secret: Schema.optional(Schema.Boolean), value: Schema.optional(Schema.Json) }),
  Rest,
);

const StoredProfile = Schema.StructWithRest(
  Schema.Struct({
    id: Schema.optional(Schema.String),
    displayName: Schema.optional(Schema.String),
    apiKey: Schema.optional(Schema.Json),
    env: Schema.optional(Schema.Array(StoredEnv)),
  }),
  Rest,
);

/**
 * worker_configs.config: the WorkerConfig in protobuf JSON form, where a profile's apiKey (and an env value) may be a
 * `{"secretRef": id}` placeholder instead of plaintext.
 */
export const StoredWorkerConfig = Schema.StructWithRest(
  Schema.Struct({ profiles: Schema.optional(Schema.Array(StoredProfile)) }),
  Rest,
);

export type StoredWorkerConfig = typeof StoredWorkerConfig.Type;

export type StoredProfile = typeof StoredProfile.Type;

export const storedWorkerConfig = Schema.decodeUnknownOption(StoredWorkerConfig);
