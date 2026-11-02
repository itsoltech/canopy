import { create, fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import {
  ConfigAppliedSchema,
  Provider,
  ProviderProfileConfigSchema,
  ProviderProfileKind,
  ui,
  type ProviderProfileConfig,
} from "@open-agents/contracts";
import { envListProblems } from "@open-agents/domain";
import { Context, Effect, Layer } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import { encryptSecret, SECRETS_KEY_ID } from "./secrets.ts";
import { Invalid, NotFound } from "./store.ts";

/**
 * Provider profiles the user manages (docs/worker-config.md, "Profile dostawców"). Profiles live in the worker's
 * configuration (worker_configs.config, protobuf JSON): every change is a new version with history, sent to the
 * worker. Secrets (the endpoint key, variables marked secret) are encrypted into `secrets` and stored in the
 * configuration as {"secretRef": "<secrets.id>"}; they never come back out of this store in clear. Which catalog
 * models a profile shows in pickers (provider_model_selections) stays in the gateway and changes no version.
 */

/** The change started from an older configuration, or a profile in use cannot be deleted. */
export class ProfileConflict extends Error {
  override readonly name = "ProfileConflict";
}

type Fx<A> = Effect.Effect<A, SqlError.SqlError | NotFound | Invalid | ProfileConflict>;

export const NATIVE_PROFILE_ID = "native";
const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;
/** Secrets this store creates; unreferenced ones are deleted after every change. */
const SECRET_PREFIX = "profile-";
const MAX_PROFILES = 32;
const MAX_SELECTION = 2000;

type SecretRef = { secretRef: string };
/** A stored profile: protobuf JSON with secrets as references. */
interface StoredProfile {
  id?: string;
  apiKey?: string | SecretRef;
  env?: { name?: string; value?: string | SecretRef; secret?: boolean }[];
  [key: string]: unknown;
}
interface StoredConfig {
  version?: string;
  profiles?: StoredProfile[];
  [key: string]: unknown;
}

export interface ModelSelectionRow {
  worker_id: string;
  profile_id: string;
  provider: "claude" | "codex";
  shown: string[];
  known: string[];
  show_new: boolean;
  updated_at: Date;
}

export interface SaveProfileInput {
  readonly userId: string;
  readonly request: ui.SaveProviderProfileRequest;
}

const isRef = (value: unknown): value is SecretRef => typeof value === "object" && value !== null && typeof (value as SecretRef).secretRef === "string";

/** The profile as a message, secrets left out (the UI learns only whether they are set). */
function decode(stored: StoredProfile): ProviderProfileConfig {
  const plain = {
    ...stored,
    apiKey: isRef(stored.apiKey) ? "" : (stored.apiKey ?? ""),
    env: (stored.env ?? []).map((v) => ({ ...v, value: isRef(v.value) || v.secret ? "" : (v.value ?? "") })),
  };
  return fromJson(ProviderProfileConfigSchema, plain as JsonValue, { ignoreUnknownFields: true });
}

function nativeProfile(): StoredProfile {
  return toJson(ProviderProfileConfigSchema, create(ProviderProfileConfigSchema, { id: NATIVE_PROFILE_ID, kind: ProviderProfileKind.NATIVE })) as StoredProfile;
}

/** Profiles of a stored configuration; the built-in native one first, also when the configuration does not list it. */
function storedProfiles(config: StoredConfig): StoredProfile[] {
  const profiles = config.profiles ?? [];
  return profiles.some((p) => p.id === NATIVE_PROFILE_ID) ? profiles : [nativeProfile(), ...profiles];
}

function secretRefs(config: StoredConfig): string[] {
  return (config.profiles ?? []).flatMap((p) => [
    ...(isRef(p.apiKey) ? [p.apiKey.secretRef] : []),
    ...(p.env ?? []).flatMap((v) => (isRef(v.value) ? [v.value.secretRef] : [])),
  ]);
}

const providerName = (provider: Provider) => (provider === Provider.CLAUDE ? "claude" : "codex");

/** A stable id from the name: lowercase, dashes, unique on the worker. */
function profileIdFrom(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "profile";
  const start = PROFILE_ID.test(base) ? base : `p-${base}`;
  let id = start;
  for (let n = 2; taken.has(id) || id === NATIVE_PROFILE_ID; n++) id = `${start}-${n}`;
  return id;
}

export class ProfileStore extends Context.Service<
  ProfileStore,
  {
    /** Profiles of a worker for the settings screen (no secret values), with the version they come from. */
    profiles(workerId: string): Fx<{ configVersion: bigint; profiles: ui.ProviderProfileSettings[] }>;
    /** Creates or changes a profile: a new configuration version. Returns it and the profile id. */
    save(input: SaveProfileInput): Fx<{ configVersion: bigint; profileId: string }>;
    /** Deletes a profile no thread uses. */
    remove(input: { userId: string; workerId: string; profileId: string; expectedVersion: bigint }): Fx<bigint>;
    /** Which models a profile shows for a provider; show all = no selection. */
    setSelection(input: { userId: string; request: ui.SetModelSelectionRequest }): Fx<ui.ModelSelection | undefined>;
    /** Model selections of the given workers (all when empty). */
    selections(workerIds: readonly string[]): Fx<readonly ModelSelectionRow[]>;
  }
>()("open-agents/gateway/ProfileStore") {
  static readonly layer = (secretsKey: Buffer) =>
    Layer.effect(
      ProfileStore,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        const configOf = (workerId: string, lock: boolean) =>
          Effect.gen(function* () {
            const rows = lock
              ? yield* sql<{ config: StoredConfig; version: bigint | number; apply_report: JsonValue | null }>`
                  SELECT config, version, apply_report FROM worker_configs WHERE worker_id = ${workerId}::uuid FOR UPDATE`
              : yield* sql<{ config: StoredConfig; version: bigint | number; apply_report: JsonValue | null }>`
                  SELECT c.config, c.version, c.apply_report FROM worker_configs c JOIN workers w ON w.id = c.worker_id
                   WHERE c.worker_id = ${workerId}::uuid AND w.archived_at IS NULL AND w.revoked_at IS NULL`;
            const row = rows[0];
            if (!row) return yield* Effect.fail(new NotFound("the worker has no configuration yet (register it with the gateway CLI)"));
            return { config: row.config, version: BigInt(row.version), report: row.apply_report };
          });

        const putSecret = (userId: string, plaintext: string) =>
          Effect.gen(function* () {
            const id = Bun.randomUUIDv7();
            yield* sql`
              INSERT INTO secrets (id, owner_user_id, name, ciphertext, key_id, created_by)
              VALUES (${id}::uuid, ${userId}::uuid, ${`${SECRET_PREFIX}${id}`}, ${encryptSecret(secretsKey, plaintext)}, ${SECRETS_KEY_ID}, ${userId}::uuid)`;
            return { secretRef: id } satisfies SecretRef;
          });

        const threadCounts = (workerId: string) =>
          sql<{ profile: string; count: bigint | number }>`
            SELECT coalesce(nullif(provider_profile_id, ''), 'native') AS profile, count(*) AS count
              FROM threads WHERE worker_id = ${workerId}::uuid AND archived_at IS NULL GROUP BY 1`.pipe(
            Effect.map((rows) => new Map(rows.map((r) => [r.profile, Number(r.count)]))),
          );

        const selectionsOf = (workerIds: readonly string[]) =>
          workerIds.length > 0
            ? sql<ModelSelectionRow>`SELECT * FROM provider_model_selections WHERE worker_id = ANY(${workerIds}::uuid[])`
            : sql<ModelSelectionRow>`SELECT * FROM provider_model_selections`;

        /** Stores the new version, the secrets it references, and drops this store's secrets nothing uses any more. */
        const write = (workerId: string, userId: string, config: StoredConfig, version: bigint) =>
          Effect.gen(function* () {
            const next = version + 1n;
            config.version = String(next);
            yield* sql`
              UPDATE worker_configs SET version = ${next}, config = ${JSON.stringify(config)}::jsonb, updated_by = ${userId}::uuid, updated_at = now()
               WHERE worker_id = ${workerId}::uuid`;
            yield* sql`DELETE FROM worker_config_secrets WHERE worker_id = ${workerId}::uuid`;
            for (const secretId of new Set(secretRefs(config))) {
              yield* sql`INSERT INTO worker_config_secrets (worker_id, secret_id) VALUES (${workerId}::uuid, ${secretId}::uuid) ON CONFLICT DO NOTHING`;
            }
            yield* sql`
              DELETE FROM secrets s WHERE s.name LIKE ${`${SECRET_PREFIX}%`}
                 AND NOT EXISTS (SELECT 1 FROM worker_config_secrets r WHERE r.secret_id = s.id)`;
            return next;
          });

        const checkVersion = (expected: bigint, current: bigint) =>
          expected !== 0n && expected !== current
            ? Effect.fail(new ProfileConflict(`the worker's configuration changed (v${current}); reload and try again`))
            : Effect.void;

        const toSelection = (row: ModelSelectionRow) =>
          create(ui.ModelSelectionSchema, {
            provider: row.provider === "claude" ? Provider.CLAUDE : Provider.CODEX,
            shown: row.shown,
            known: row.known,
            showNew: row.show_new,
            updatedAt: timestampFromDate(new Date(row.updated_at)),
          });

        return ProfileStore.of({
          profiles: (workerId) =>
            Effect.gen(function* () {
              const { config, version, report } = yield* configOf(workerId, false);
              const applied = report ? fromJson(ConfigAppliedSchema, report, { ignoreUnknownFields: true }) : undefined;
              const counts = yield* threadCounts(workerId);
              const selections = yield* selectionsOf([workerId]);
              const profiles = storedProfiles(config).map((stored) => {
                const profile = decode(stored);
                const reported = applied?.profiles.find((p) => p.id === profile.id);
                const builtIn = profile.id === NATIVE_PROFILE_ID;
                return create(ui.ProviderProfileSettingsSchema, {
                  workerId,
                  id: profile.id,
                  displayName: profile.displayName,
                  kind: profile.kind,
                  providers: profile.providers.length > 0 ? profile.providers : [Provider.CLAUDE, Provider.CODEX],
                  baseUrl: profile.baseUrl,
                  apiKeySet: stored.apiKey !== undefined && stored.apiKey !== "",
                  env: profile.env.map((v) => ({ name: v.name, secret: v.secret, value: v.secret ? "" : v.value })),
                  enabled: !profile.disabled,
                  builtIn,
                  // Native is always there; a profile the worker has not reported yet is not available yet.
                  available: reported?.available ?? false,
                  detail: reported ? reported.detail : "not applied by the worker yet",
                  threadCount: counts.get(profile.id) ?? 0,
                  modelSelections: selections.filter((s) => s.profile_id === profile.id).map(toSelection),
                });
              });
              return { configVersion: version, profiles };
            }),

          save: ({ userId, request }) =>
            sql.withTransaction(
              Effect.gen(function* () {
                const { config, version } = yield* configOf(request.workerId, true);
                yield* checkVersion(request.expectedConfigVersion, version);
                const profiles = storedProfiles(config);
                const existing = request.profileId ? profiles.find((p) => p.id === request.profileId) : undefined;
                if (request.profileId && !existing) return yield* Effect.fail(new NotFound(`profile ${request.profileId} not found`));
                if (!existing && profiles.length >= MAX_PROFILES) return yield* Effect.fail(new Invalid(`at most ${MAX_PROFILES} profiles per worker`));
                const builtIn = existing?.id === NATIVE_PROFILE_ID;

                const displayName = request.displayName.trim();
                if (!displayName && !builtIn) return yield* Effect.fail(new Invalid("name is required"));
                if (displayName.length > 80) return yield* Effect.fail(new Invalid("name is longer than 80 characters"));
                const kind = builtIn ? ProviderProfileKind.NATIVE : request.kind;
                if (kind !== ProviderProfileKind.NATIVE && kind !== ProviderProfileKind.CLIPROXYAPI) return yield* Effect.fail(new Invalid("choose how the profile connects"));
                if (builtIn && !request.enabled) return yield* Effect.fail(new Invalid("the device login profile cannot be disabled"));
                const providers = builtIn
                  ? []
                  : [...new Set(request.providers)].filter((p) => p === Provider.CLAUDE || p === Provider.CODEX).sort();
                if (!builtIn && providers.length === 0) return yield* Effect.fail(new Invalid("choose at least one agent (Claude or Codex)"));

                let baseUrl = "";
                if (kind === ProviderProfileKind.CLIPROXYAPI) {
                  const url = URL.canParse(request.baseUrl.trim()) ? new URL(request.baseUrl.trim()) : undefined;
                  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return yield* Effect.fail(new Invalid("the endpoint must be an http(s) URL"));
                  if (url.username || url.password) return yield* Effect.fail(new Invalid("put the key in the API key field, not in the URL"));
                  baseUrl = request.baseUrl.trim();
                }

                // Variables: names checked by the same rules as on the worker; values only for the size and NUL checks.
                const previous = new Map((existing?.env ?? []).map((v) => [v.name ?? "", v]));
                const ruleKind = kind === ProviderProfileKind.NATIVE ? "native" : "endpoint";
                const problem = envListProblems(ruleKind, request.env.map((v) => ({ name: v.name, value: v.value ?? "" })))[0];
                if (problem) return yield* Effect.fail(new Invalid(problem.message));
                const env: NonNullable<StoredProfile["env"]> = [];
                for (const input of request.env) {
                  if (!input.secret) {
                    env.push({ name: input.name, value: input.value ?? "" });
                    continue;
                  }
                  if (input.value !== undefined) {
                    env.push({ name: input.name, secret: true, value: yield* putSecret(userId, input.value) });
                    continue;
                  }
                  const kept = previous.get(input.name);
                  if (!kept?.secret || !isRef(kept.value)) return yield* Effect.fail(new Invalid(`${input.name}: enter the secret value`));
                  env.push({ name: input.name, secret: true, value: kept.value });
                }

                // The key: unset keeps it, "" clears it, a value replaces it. Only endpoint profiles have one.
                let apiKey: StoredProfile["apiKey"];
                if (kind === ProviderProfileKind.CLIPROXYAPI) {
                  if (request.apiKey === undefined) apiKey = existing?.apiKey;
                  else if (request.apiKey !== "") apiKey = yield* putSecret(userId, request.apiKey);
                }

                const profileId = existing?.id ?? profileIdFrom(displayName, new Set(profiles.map((p) => p.id ?? "")));
                const message = create(ProviderProfileConfigSchema, {
                  id: profileId,
                  kind,
                  providers,
                  baseUrl,
                  displayName,
                  disabled: !request.enabled,
                });
                const stored = toJson(ProviderProfileConfigSchema, message) as StoredProfile;
                if (apiKey) stored.apiKey = apiKey;
                if (env.length > 0) stored.env = env;

                const next = existing ? profiles.map((p) => (p === existing ? stored : p)) : [...profiles, stored];
                const configVersion = yield* write(request.workerId, userId, { ...config, profiles: next }, version);
                return { configVersion, profileId };
              }),
            ),

          remove: ({ userId, workerId, profileId, expectedVersion }) =>
            sql.withTransaction(
              Effect.gen(function* () {
                if (profileId === NATIVE_PROFILE_ID) return yield* Effect.fail(new Invalid("the device login profile cannot be deleted"));
                const { config, version } = yield* configOf(workerId, true);
                yield* checkVersion(expectedVersion, version);
                const profiles = storedProfiles(config);
                if (!profiles.some((p) => p.id === profileId)) return yield* Effect.fail(new NotFound(`profile ${profileId} not found`));
                const used = (yield* threadCounts(workerId)).get(profileId) ?? 0;
                if (used > 0) {
                  return yield* Effect.fail(
                    new ProfileConflict(`${used} thread${used === 1 ? " uses" : "s use"} this profile; disable it instead (its threads then show why they cannot run)`),
                  );
                }
                yield* sql`DELETE FROM provider_model_selections WHERE worker_id = ${workerId}::uuid AND profile_id = ${profileId}`;
                return yield* write(workerId, userId, { ...config, profiles: profiles.filter((p) => p.id !== profileId) }, version);
              }),
            ),

          setSelection: ({ userId, request }) =>
            Effect.gen(function* () {
              const { config } = yield* configOf(request.workerId, false);
              if (!storedProfiles(config).some((p) => p.id === request.profileId)) return yield* Effect.fail(new NotFound(`profile ${request.profileId} not found`));
              if (request.provider !== Provider.CLAUDE && request.provider !== Provider.CODEX) return yield* Effect.fail(new Invalid("choose Claude or Codex"));
              const provider = providerName(request.provider);
              if (request.showAll) {
                yield* sql`DELETE FROM provider_model_selections WHERE worker_id = ${request.workerId}::uuid AND profile_id = ${request.profileId} AND provider = ${provider}`;
                return undefined;
              }
              const shown = [...new Set(request.shown)];
              const known = [...new Set([...request.known, ...shown])];
              if (known.length > MAX_SELECTION || known.some((m) => !m || m.length > 200)) return yield* Effect.fail(new Invalid("invalid model list"));
              const rows = yield* sql<ModelSelectionRow>`
                INSERT INTO provider_model_selections (worker_id, profile_id, provider, shown, known, show_new, updated_by)
                VALUES (${request.workerId}::uuid, ${request.profileId}, ${provider}, ${shown}::text[], ${known}::text[], ${request.showNew}, ${userId}::uuid)
                ON CONFLICT (worker_id, profile_id, provider) DO UPDATE
                  SET shown = EXCLUDED.shown, known = EXCLUDED.known, show_new = EXCLUDED.show_new, updated_by = EXCLUDED.updated_by, updated_at = now()
                RETURNING *`;
              return toSelection(rows[0]!);
            }),

          selections: (workerIds) => selectionsOf(workerIds),
        });
      }),
    );
}
