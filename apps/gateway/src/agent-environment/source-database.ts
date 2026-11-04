import { create, fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { GatewayStore } from "../store/store.ts";
import type { AgentEnvironment } from "./service.ts";
import { uuid } from "./composition.ts";

export class SourceDatabase {
  constructor(readonly environment: AgentEnvironment) {}

  async authorization(source: ui.SkillSource): Promise<string> {
    if (!source.credentialAccountId) return "";

    if (!uuid(source.credentialAccountId))
      throw new ConnectError("Invalid connector account ID.", Code.InvalidArgument);
    const owner = this.environment.options.userId;

    // Store credentials are decrypted only inside the gateway. Only this closure returns the auth header.
    try {
      return await this.environment.options.runtime.runPromise(
        GatewayStore.use((store) =>
          Effect.gen(function* () {
            const account = yield* store.connectors.owned(owner, source.credentialAccountId);
            const sourceOrigin = new URL(source.url).origin;

            const githubAccount =
              account.connector_type === "github" &&
              account.url === "https://api.githubcopilot.com/mcp/" &&
              sourceOrigin === "https://github.com";

            if (account.status !== "connected" || (!githubAccount && new URL(account.url).origin !== sourceOrigin))
              return yield* Effect.fail(new Error("Source connector access denied."));
            const value = yield* store.connectors.credentials(account);

            const authorization =
              Object.entries(value.headers ?? {}).find(([name]) => name.toLowerCase() === "authorization")?.[1] ??
              (value.tokens?.access_token ? `Bearer ${value.tokens.access_token}` : "");

            if (!authorization || /[\r\n]/.test(authorization))
              return yield* Effect.fail(new Error("Source connector credentials unavailable."));

            return new URL(source.url).hostname === "github.com" && authorization.startsWith("Bearer ")
              ? `Basic ${Buffer.from(`x-access-token:${authorization.slice(7)}`).toString("base64")}`
              : authorization;
          }),
        ),
      );
    } catch {
      throw new ConnectError(
        "Source connector is unavailable, disconnected or belongs to a different origin or owner.",
        Code.PermissionDenied,
      );
    }
  }

  async save(preview: ui.SkillSourcePreview) {
    const owner = this.environment.options.userId;

    return this.environment.db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM agent_skill_source_previews WHERE owner_user_id = ${owner}::uuid AND expires_at < now()`;
            // Bounded durable cache; no artifacts or credentials in process logs.
            yield* sql`DELETE FROM agent_skill_source_previews WHERE id IN (
          SELECT id FROM agent_skill_source_previews WHERE owner_user_id = ${owner}::uuid ORDER BY expires_at DESC OFFSET 4)`;
            const json = JSON.stringify(toJson(ui.SkillSourcePreviewSchema, preview));
            yield* sql`INSERT INTO agent_skill_source_previews(id, owner_user_id, preview, expires_at)
          VALUES (${preview.id}::uuid, ${owner}::uuid, ${json}::jsonb, ${preview.expiresAt}::timestamptz)`;
          }),
        );
      }),
    );
  }

  async load(id: string) {
    const owner = this.environment.options.userId;

    if (!uuid(id)) throw new ConnectError("Invalid preview ID.", Code.InvalidArgument);

    return this.environment.db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        const rows = yield* sql<{ preview: JsonValue }>`SELECT preview FROM agent_skill_source_previews
        WHERE id = ${id}::uuid AND owner_user_id = ${owner}::uuid AND expires_at > now()`;

        if (!rows[0])
          return yield* Effect.fail(
            new ConnectError("Preview expired or not found. Resolve the source again.", Code.NotFound),
          );

        return fromJson(ui.SkillSourcePreviewSchema, rows[0].preview);
      }),
    );
  }
}

export const sourcePolicy = (source: ui.SkillSource, commit: string) =>
  create(ui.SkillSourceSchema, {
    ...source,
    commit,
    availableCommit: "",
    updatePreviewId: "",
    checkedAt: "",
    error: "",
  });
