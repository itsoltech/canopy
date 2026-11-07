import { create, fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { AgentEnvironment } from "./service.ts";
import { audit } from "./database.ts";
import { marketplaces, saveMarketplace, plugins } from "./plugin-database.ts";
import { discoverMarketplace, marketplaceReference } from "./marketplace-discovery.ts";
import { uuid } from "./composition.ts";

export class EnvironmentMarketplaces {
  #busy = false;
  #abort = new AbortController();
  #pending = new Set<Promise<ui.MarketplacePreview>>();
  constructor(readonly environment: AgentEnvironment) {}

  preview(request: ui.PreviewMarketplaceRequest) {
    const pending = this.fetch(request);
    this.#pending.add(pending);
    void pending.finally(() => this.#pending.delete(pending)).catch(() => {});

    return pending;
  }

  private async fetch(request: ui.PreviewMarketplaceRequest) {
    if (this.#busy) throw new ConnectError("A marketplace is already being resolved.", Code.ResourceExhausted);
    this.#abort.signal.throwIfAborted();
    this.#busy = true;

    try {
      const current = request.id
        ? (await this.environment.snapshot()).marketplaces.find((m) => m.id === request.id)
        : undefined;

      if (request.id && !current?.source) throw new ConnectError("Marketplace not found.", Code.NotFound);
      const source = current?.source ?? marketplaceReference(request.command);

      if (!current) source.credentialAccountId = request.credentialAccountId;
      const authorization = await this.environment.sources.db.authorization(source);
      let marketplace;

      try {
        marketplace = await discoverMarketplace(source, authorization, {
          ...this.environment.options.sources,
          signal: AbortSignal.any([this.#abort.signal, AbortSignal.timeout(120_000)]),
        });
      } catch {
        throw new ConnectError(
          "Couldn't read marketplace. Check its manifest, source access and file limits.",
          Code.InvalidArgument,
        );
      }

      if (current && current.name !== marketplace.name)
        throw new ConnectError("Marketplace identity changed.", Code.FailedPrecondition);
      marketplace.id = current?.id ?? "";

      const preview = create(ui.MarketplacePreviewSchema, {
        id: Bun.randomUUIDv7(),
        marketplace,
        baseCommit: current?.source?.commit ?? "",
        expiresAt: new Date(Date.now() + 1800_000).toISOString(),
      });

      const owner = this.environment.options.userId;
      await this.environment.db.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DELETE FROM agent_marketplace_previews WHERE owner_user_id = ${owner}::uuid AND expires_at < now()`;
          yield* sql`DELETE FROM agent_marketplace_previews WHERE id IN (SELECT id FROM agent_marketplace_previews WHERE owner_user_id = ${owner}::uuid ORDER BY expires_at DESC OFFSET 3)`;
          const json = JSON.stringify(toJson(ui.MarketplacePreviewSchema, preview));
          yield* sql`INSERT INTO agent_marketplace_previews (id, owner_user_id, preview, expires_at) VALUES (${preview.id}::uuid, ${owner}::uuid, ${json}::jsonb, ${preview.expiresAt}::timestamptz)`;
        }),
      );

      return preview;
    } finally {
      this.#busy = false;
    }
  }

  /** `receipt` runs in the same transaction, after the change (imports, docs/import.md "Blokady"). */
  async save(request: ui.SaveMarketplaceRequest, receipt?: (sql: SqlClient.SqlClient) => Effect.Effect<void>) {
    if (!uuid(request.previewId)) throw new ConnectError("Invalid preview ID.", Code.InvalidArgument);
    const owner = this.environment.options.userId;
    const environment = this.environment;

    const preview = await environment.db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        const rows = yield* sql<{
          preview: JsonValue;
        }>`SELECT preview FROM agent_marketplace_previews WHERE id = ${request.previewId}::uuid AND owner_user_id = ${owner}::uuid AND expires_at > now()`;

        if (!rows[0])
          return yield* Effect.fail(new ConnectError("Marketplace preview expired or not found.", Code.NotFound));

        return fromJson(ui.MarketplacePreviewSchema, rows[0].preview);
      }),
    );

    const marketplace = preview.marketplace!;
    await environment.sources.db.authorization(marketplace.source!);
    await environment.db.mutate(
      request.expectedRevision,
      (sql) =>
        Effect.gen(function* () {
          const library = yield* marketplaces(sql, owner);
          const previous = library.find((m) => m.id === marketplace.id);

          if (marketplace.id && (!previous || previous.source?.commit !== preview.baseCommit))
            return yield* Effect.fail(
              new ConnectError("Marketplace changed. Preview it again.", Code.FailedPrecondition),
            );

          if (
            (!previous && library.length >= 30) ||
            library.some((m) => m.id !== marketplace.id && m.name === marketplace.name)
          )
            return yield* Effect.fail(
              new ConnectError("Use unique marketplace names, up to 30 marketplaces.", Code.InvalidArgument),
            );
          marketplace.id ||= Bun.randomUUIDv7();
          yield* saveMarketplace(sql, owner, marketplace);
          yield* audit(
            sql,
            owner,
            previous ? "environment.marketplace.update" : "environment.marketplace.add",
            marketplace.id,
          );
          yield* sql`DELETE FROM agent_marketplace_previews WHERE id = ${preview.id}::uuid AND owner_user_id = ${owner}::uuid`;
        }),
      receipt,
    );

    return environment.changed();
  }

  /** `receipt` runs in the same transaction, after the change (imports, docs/import.md "Blokady"). */
  async remove(request: ui.DeleteMarketplaceRequest, receipt?: (sql: SqlClient.SqlClient) => Effect.Effect<void>) {
    const owner = this.environment.options.userId;
    await this.environment.db.mutate(
      request.expectedRevision,
      (sql) =>
        Effect.gen(function* () {
          if (!(yield* marketplaces(sql, owner)).some((m) => m.id === request.id))
            return yield* Effect.fail(new ConnectError("Marketplace not found.", Code.NotFound));

          if ((yield* plugins(sql, owner)).some((p) => p.marketplaceId === request.id))
            return yield* Effect.fail(
              new ConnectError("Remove this marketplace's enabled plugins first.", Code.FailedPrecondition),
            );
          yield* sql`DELETE FROM agent_marketplaces WHERE id = ${request.id}::uuid AND owner_user_id = ${owner}::uuid`;
          yield* audit(sql, owner, "environment.marketplace.delete", request.id);
        }),
      receipt,
    );

    return this.environment.changed();
  }

  async stop() {
    this.#abort.abort();
    await Promise.allSettled(this.#pending);
  }
}
