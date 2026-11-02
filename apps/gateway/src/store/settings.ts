import { create, fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ui } from "@open-agents/contracts";
import { Context, Effect, Layer } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import { isUniqueViolation } from "./agent-bus.ts";
import { NotFound } from "./store.ts";

/**
 * User and project settings (docs/ui-api.md): stored by the gateway, the browser only reads and writes
 * them. Stored sections are read leniently (fields dropped from the contract are ignored).
 * Sections (appearance, thread defaults, model favorites, composer) are replaced as a whole; every write bumps the version and
 * names the version it started from, so two devices never overwrite each other unnoticed.
 */

/** The write started from an older version: the client reloads and applies its change again. */
export class SettingsConflict extends Error {
  override readonly name = "SettingsConflict";
}

type Fx<A> = Effect.Effect<A, SqlError.SqlError | NotFound | SettingsConflict>;

interface Row {
  settings: JsonValue;
  version: bigint | number;
  updated_at: Date;
}
interface ProjectRow extends Row {
  project_id: string;
}

/** Stored JSON: the protobuf JSON of each section. */
interface Stored {
  appearance?: JsonValue;
  threadDefaults?: JsonValue;
  modelFavorites?: JsonValue;
  composer?: JsonValue;
}

export class SettingsStore extends Context.Service<
  SettingsStore,
  {
    user(userId: string): Fx<ui.UserSettings>;
    projects(ownerUserId: string): Fx<ui.ProjectSettings[]>;
    updateUser(input: {
      userId: string;
      appearance?: ui.AppearanceSettings;
      threadDefaults?: ui.ThreadDefaults;
      modelFavorites?: ui.ModelFavorites;
      composer?: ui.ComposerSettings;
      expectedVersion: bigint;
    }): Fx<ui.UserSettings>;
    updateProject(input: { userId: string; projectId: string; threadDefaults?: ui.ThreadDefaults; expectedVersion: bigint }): Fx<ui.ProjectSettings>;
  }
>()("open-agents/gateway/SettingsStore") {
  static readonly layer = Layer.effect(
    SettingsStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const appearance = (stored: Stored) =>
        stored.appearance ? fromJson(ui.AppearanceSettingsSchema, stored.appearance, { ignoreUnknownFields: true }) : create(ui.AppearanceSettingsSchema, {});
      const threadDefaults = (stored: Stored) =>
        stored.threadDefaults ? fromJson(ui.ThreadDefaultsSchema, stored.threadDefaults, { ignoreUnknownFields: true }) : create(ui.ThreadDefaultsSchema, {});

      const modelFavorites = (stored: Stored) =>
        stored.modelFavorites ? fromJson(ui.ModelFavoritesSchema, stored.modelFavorites, { ignoreUnknownFields: true }) : create(ui.ModelFavoritesSchema, {});

      const composer = (stored: Stored) =>
        stored.composer ? fromJson(ui.ComposerSettingsSchema, stored.composer, { ignoreUnknownFields: true }) : create(ui.ComposerSettingsSchema, {});

      const toUser = (row: Row | undefined) => {
        const stored = (row?.settings ?? {}) as Stored;
        return create(ui.UserSettingsSchema, {
          appearance: appearance(stored),
          threadDefaults: threadDefaults(stored),
          modelFavorites: modelFavorites(stored),
          composer: composer(stored),
          version: BigInt(row?.version ?? 0),
          ...(row && { updatedAt: timestampFromDate(new Date(row.updated_at)) }),
        });
      };
      const toProject = (projectId: string, row: Row | undefined) =>
        create(ui.ProjectSettingsSchema, {
          projectId,
          threadDefaults: threadDefaults((row?.settings ?? {}) as Stored),
          version: BigInt(row?.version ?? 0),
          ...(row && { updatedAt: timestampFromDate(new Date(row.updated_at)) }),
        });

      /** Writes `next` if the stored version is still `expected` (0 = nothing stored yet). */
      const write = <R extends Row>(input: {
        current: R | undefined;
        expected: bigint;
        next: Stored;
        insert: (settings: string) => Effect.Effect<readonly R[], SqlError.SqlError>;
        update: (settings: string, version: bigint) => Effect.Effect<readonly R[], SqlError.SqlError>;
      }) =>
        Effect.gen(function* () {
          const version = BigInt(input.current?.version ?? 0);
          if (version !== input.expected) return yield* Effect.fail(new SettingsConflict("settings changed elsewhere; reload them"));
          const settings = JSON.stringify(input.next);
          const rows = input.current ? yield* input.update(settings, version) : yield* input.insert(settings);
          if (!rows[0]) return yield* Effect.fail(new SettingsConflict("settings changed elsewhere; reload them"));
          return rows[0];
        }).pipe(
          // Two first writes at once: the loser sees the primary key taken.
          Effect.catchTag("SqlError", (error): Effect.Effect<never, SettingsConflict | SqlError.SqlError> =>
            isUniqueViolation(error) ? Effect.fail(new SettingsConflict("settings changed elsewhere; reload them")) : Effect.fail(error),
          ),
        );

      const store: SettingsStore["Service"] = {
        user: (userId) =>
          sql<Row>`SELECT settings, version, updated_at FROM user_settings WHERE user_id = ${userId}::uuid`.pipe(Effect.map((rows) => toUser(rows[0]))),

        projects: (ownerUserId) =>
          sql<ProjectRow>`
            SELECT s.project_id, s.settings, s.version, s.updated_at FROM project_settings s JOIN projects p ON p.id = s.project_id
             WHERE p.owner_user_id = ${ownerUserId}::uuid AND p.archived_at IS NULL ORDER BY p.created_at`.pipe(
            Effect.map((rows) => rows.map((r) => toProject(r.project_id, r))),
          ),

        updateUser: ({ userId, appearance: nextAppearance, threadDefaults: nextDefaults, modelFavorites: nextFavorites, composer: nextComposer, expectedVersion }) =>
          sql.withTransaction(
            Effect.gen(function* () {
              const current = (yield* sql<Row>`SELECT settings, version, updated_at FROM user_settings WHERE user_id = ${userId}::uuid FOR UPDATE`)[0];
              const stored = (current?.settings ?? {}) as Stored;
              const next: Stored = {
                ...stored,
                ...(nextAppearance && { appearance: toJson(ui.AppearanceSettingsSchema, nextAppearance) }),
                ...(nextDefaults && { threadDefaults: toJson(ui.ThreadDefaultsSchema, nextDefaults) }),
                ...(nextFavorites && { modelFavorites: toJson(ui.ModelFavoritesSchema, nextFavorites) }),
                ...(nextComposer && { composer: toJson(ui.ComposerSettingsSchema, nextComposer) }),
              };
              const row = yield* write({
                current,
                expected: expectedVersion,
                next,
                insert: (settings) => sql<Row>`
                  INSERT INTO user_settings (user_id, settings, version) VALUES (${userId}::uuid, ${settings}::jsonb, 1)
                  RETURNING settings, version, updated_at`,
                update: (settings, version) => sql<Row>`
                  UPDATE user_settings SET settings = ${settings}::jsonb, version = version + 1, updated_at = now()
                   WHERE user_id = ${userId}::uuid AND version = ${version} RETURNING settings, version, updated_at`,
              });
              return toUser(row);
            }),
          ),

        updateProject: ({ userId, projectId, threadDefaults: nextDefaults, expectedVersion }) =>
          sql.withTransaction(
            Effect.gen(function* () {
              const owned = yield* sql`SELECT 1 FROM projects WHERE id = ${projectId}::uuid AND owner_user_id = ${userId}::uuid AND archived_at IS NULL`;
              if (owned.length === 0) return yield* Effect.fail(new NotFound("project not found"));
              const current = (yield* sql<Row>`SELECT settings, version, updated_at FROM project_settings WHERE project_id = ${projectId}::uuid FOR UPDATE`)[0];
              const stored = (current?.settings ?? {}) as Stored;
              const next: Stored = { ...stored, ...(nextDefaults && { threadDefaults: toJson(ui.ThreadDefaultsSchema, nextDefaults) }) };
              const row = yield* write({
                current,
                expected: expectedVersion,
                next,
                insert: (settings) => sql<Row>`
                  INSERT INTO project_settings (project_id, settings, version, updated_by) VALUES (${projectId}::uuid, ${settings}::jsonb, 1, ${userId}::uuid)
                  RETURNING settings, version, updated_at`,
                update: (settings, version) => sql<Row>`
                  UPDATE project_settings SET settings = ${settings}::jsonb, version = version + 1, updated_by = ${userId}::uuid, updated_at = now()
                   WHERE project_id = ${projectId}::uuid AND version = ${version} RETURNING settings, version, updated_at`,
              });
              return toProject(projectId, row);
            }),
          ),
      };
      return SettingsStore.of(store);
    }),
  );
}
