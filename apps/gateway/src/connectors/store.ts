import { create, fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { connectors, ConnectorToolSchema, type ConnectorTool } from "@canopy/contracts";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { createHash } from "node:crypto";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { decryptSecret, encryptSecret } from "../store/secrets.ts";
import { connectorType, connectorUrl } from "./catalog.ts";

export class ConnectorFailure extends Error {}

export interface Credentials {
  headers?: Record<string, string>;
  tokens?: OAuthTokens;
  client?: OAuthClientInformationMixed;
  discovery?: OAuthDiscoveryState;
  verifier?: string;
  redirectUri?: string;
  expiresAt?: number;
}

export interface AccountRow {
  id: string;
  owner_user_id: string;
  connector_type: string;
  name: string;
  namespace: string;
  url: string;
  transport: string;
  auth_kind: string;
  credentials: Uint8Array | null;
  legacy_headers: Record<string, { secretRef: string }>;
  status: string;
  all_workers: boolean;
  all_bots: boolean;
  revision: bigint | string;
  tools: JsonValue[];
  last_used_at: Date | null;
}

export interface ExecutionSource {
  userId: string;
  accountId: string;
  workerId?: string;
  threadId?: string;
  turnId?: string;
  botId?: string;
  readOnlyOnly?: boolean;
}

export const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const fail = (message: string) => Effect.fail(new ConnectorFailure(message));

const checked = <A>(run: () => A) =>
  Effect.try({ try: run, catch: () => new ConnectorFailure("Invalid connector configuration") });

/** Attached to GatewayStore and shared with the legacy bot RPC adapter; one persistence model. */
export function connectorStore(sql: SqlClient.SqlClient, key: Buffer) {
  const owned = (user: string, id: string, lock = false) =>
    sql
      .unsafe<AccountRow>(
        `SELECT * FROM connector_accounts WHERE id=$1::uuid AND owner_user_id=$2::uuid${lock ? " FOR UPDATE" : ""}`,
        [id, user],
      )
      .pipe(Effect.flatMap((r) => (r[0] ? Effect.succeed(r[0]) : fail("Connector account not found"))));

  // SAFETY: only this store writes sealed columns: JSON of the declared type, encrypted with AES-256-GCM under
  // `key`. Decryption rejects any other ciphertext, so the plaintext is that JSON.
  const opened = <T>(sealed: Parameters<typeof decryptSecret>[1]): T => JSON.parse(decryptSecret(key, sealed)) as T;

  const unseal = (row: AccountRow): Credentials => (row.credentials ? opened<Credentials>(row.credentials) : {});

  const seal = (value: Credentials) => encryptSecret(key, JSON.stringify(value));

  const credentials = (row: AccountRow) =>
    Effect.gen(function* () {
      const value = unseal(row);
      const headers = { ...value.headers };

      for (const [name, ref] of Object.entries(row.legacy_headers)) {
        const secret = (yield* sql<{
          ciphertext: Uint8Array;
        }>`SELECT ciphertext FROM secrets WHERE id=${ref.secretRef}::uuid AND owner_user_id=${row.owner_user_id}::uuid`)[0];

        if (!secret) return yield* fail("Connector credentials unavailable");
        headers[name] = decryptSecret(key, secret.ciphertext);
      }

      return { ...value, headers };
    });

  const view = (row: AccountRow) =>
    Effect.gen(function* () {
      const workers = yield* sql<{
        worker_id: string;
      }>`SELECT worker_id FROM connector_worker_grants WHERE account_id=${row.id}::uuid`;

      const bots = yield* sql<{
        bot_id: string;
      }>`SELECT bot_id FROM connector_bot_grants WHERE account_id=${row.id}::uuid`;

      return create(connectors.ConnectorAccountSchema, {
        id: row.id,
        connectorType: row.connector_type,
        name: row.name,
        namespace: row.namespace,
        url: row.url,
        transport: row.transport,
        authKind: row.auth_kind,
        status: row.status,
        allWorkers: row.all_workers,
        workerIds: workers.map((w) => w.worker_id),
        allBots: row.all_bots,
        botIds: bots.map((b) => b.bot_id),
        revision: BigInt(row.revision),
        ...(row.last_used_at && { lastUsedAt: timestampFromDate(new Date(row.last_used_at)) }),
        headerNames: [...new Set([...Object.keys(unseal(row).headers ?? {}), ...Object.keys(row.legacy_headers)])],
      });
    });

  const authorize = (source: ExecutionSource, connected = true) =>
    Effect.gen(function* () {
      const account = yield* owned(source.userId, source.accountId);

      if (connected && account.status !== "connected")
        return yield* fail("Connector needs reconnect or is disconnected");

      if (source.threadId) {
        const thread = (yield* sql<{
          worker_id: string;
        }>`SELECT worker_id FROM threads WHERE id=${source.threadId}::uuid
        AND owner_user_id=${source.userId}::uuid AND runtime='worker' AND archived_at IS NULL AND deleted_at IS NULL`)[0];

        if (!thread || thread.worker_id !== source.workerId) return yield* fail("Connector access denied");

        const worker =
          yield* sql`SELECT id FROM workers WHERE id=${thread.worker_id}::uuid AND revoked_at IS NULL AND archived_at IS NULL
        AND (owner_user_id=${source.userId}::uuid OR owner_user_id IS NULL)`;

        const grant =
          yield* sql`SELECT 1 FROM connector_worker_grants WHERE account_id=${account.id}::uuid AND worker_id=${thread.worker_id}::uuid`;

        if (!worker.length || (!account.all_workers && !grant.length)) return yield* fail("Connector access denied");
      } else if (source.botId) {
        const bot =
          yield* sql`SELECT id FROM bots WHERE id=${source.botId}::uuid AND owner_user_id=${source.userId}::uuid AND deleted_at IS NULL AND archived_at IS NULL`;

        const grant =
          yield* sql`SELECT 1 FROM connector_bot_grants WHERE account_id=${account.id}::uuid AND bot_id=${source.botId}::uuid`;

        if (!bot.length || (!account.all_bots && !grant.length)) return yield* fail("Connector access denied");
      } else return yield* fail("Connector access denied");

      return account;
    });

  const list = (user: string, scope: { workerId?: string; threadId?: string; botId?: string } = {}) =>
    Effect.gen(function* () {
      let workerId = scope.workerId;

      if (scope.threadId) {
        const row = (yield* sql<{
          worker_id: string;
        }>`SELECT worker_id FROM threads WHERE id=${scope.threadId}::uuid AND owner_user_id=${user}::uuid AND deleted_at IS NULL`)[0];

        if (!row) return yield* fail("Thread not found");
        workerId = row.worker_id;
      }

      if (
        scope.botId &&
        !(yield* sql`SELECT id FROM bots WHERE id=${scope.botId}::uuid AND owner_user_id=${user}::uuid AND deleted_at IS NULL`)
          .length
      )
        return yield* fail("Bot not found");

      const rows = yield* sql<AccountRow>`SELECT a.* FROM connector_accounts a WHERE owner_user_id=${user}::uuid
      AND (${workerId ?? null}::uuid IS NULL OR (a.all_workers OR EXISTS(SELECT 1 FROM connector_worker_grants g WHERE g.account_id=a.id AND g.worker_id=${workerId ?? null}::uuid)))
      AND (${scope.botId ?? null}::uuid IS NULL OR (a.all_bots OR EXISTS(SELECT 1 FROM connector_bot_grants g WHERE g.account_id=a.id AND g.bot_id=${scope.botId ?? null}::uuid)))
      ORDER BY connector_type, name, id`;

      return rows;
    });

  const updateCredentials = (row: AccountRow, value: Credentials, status = row.status) =>
    sql`UPDATE connector_accounts SET credentials=${seal(value)}, legacy_headers='{}', status=${status}, updated_at=now() WHERE id=${row.id}::uuid`;

  const audit = (
    source: ExecutionSource,
    tool: string,
    outcome: string,
  ) => sql`INSERT INTO connector_audit(account_id,owner_user_id,worker_id,thread_id,bot_id,tool,outcome)
    VALUES (${source.accountId}::uuid,${source.userId}::uuid,${source.workerId ?? null}::uuid,${source.threadId ?? null}::uuid,${source.botId ?? null}::uuid,${tool.slice(0, 128)},${outcome})`;

  return {
    owned,
    credentials,
    unseal,
    seal,
    view,
    authorize,
    list,
    updateCredentials,
    audit,
    transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => sql.withTransaction(effect),
    save: (user: string, request: connectors.SaveConnectorAccountRequest) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const old = request.id ? yield* owned(user, request.id, true) : undefined;

          if (old && BigInt(old.revision) !== request.expectedRevision)
            return yield* fail("Connector changed; reload and try again");
          const type = connectorType(old?.connector_type ?? request.connectorType);
          const name = request.name.trim().normalize("NFC");

          // oxlint-disable-next-line no-control-regex -- an account name is one line of visible text
          if (!type || !name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name))
            return yield* fail("Choose a connector type and an account name (up to 80 characters)");
          const url = yield* checked(() => connectorUrl(request.url || old?.url || type.url));
          const transport = request.transport || old?.transport || "http";
          const authKind = request.authKind || old?.auth_kind || type.authKinds[0]!;

          if (!["http", "sse"].includes(transport) || !type.authKinds.includes(authKind))
            return yield* fail("Unsupported connector transport or authentication");

          if (
            old &&
            (url !== old.url || transport !== old.transport || authKind !== old.auth_kind) &&
            !request.replaceCredentials
          )
            return yield* fail("Reconnect to change the endpoint or authentication");
          const id = old?.id ?? Bun.randomUUIDv7();

          const namespace =
            old?.namespace ??
            `${type.id}_${
              name
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "_")
                .slice(0, 12) || "account"
            }_${digest(id).slice(0, 8)}`;

          let value = old ? yield* credentials(old) : {};

          const replacing =
            request.replaceCredentials || !old || !!request.token || Object.keys(request.headers).length > 0;

          if (replacing) {
            const headers = { ...request.headers };

            if (request.token) headers["Authorization"] = `Bearer ${request.token}`;

            if (Object.keys(headers).length > 32) return yield* fail("Too many connector headers");

            for (const [header, text] of Object.entries(headers))
              if (
                !/^[a-zA-Z0-9_-]{1,100}$/.test(header) ||
                /^(host|content-length|connection|accept|content-type|mcp-session-id)$/i.test(header) ||
                /[\r\n]/.test(text) ||
                text.length > 32_000
              )
                return yield* fail("Invalid connector header");

            if (new Set(Object.keys(headers).map((h) => h.toLowerCase())).size !== Object.keys(headers).length)
              return yield* fail("Duplicate connector header");
            value = { headers };
          }

          const status = replacing ? (authKind === "oauth" ? "needs_reconnect" : "connected") : old!.status;
          yield* sql`INSERT INTO connector_accounts(id,owner_user_id,connector_type,name,namespace,url,transport,auth_kind,credentials,status)
        VALUES (${id}::uuid,${user}::uuid,${type.id},${name},${namespace},${url},${transport},${authKind},${seal(value)},${status})
        ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,url=EXCLUDED.url,transport=EXCLUDED.transport,auth_kind=EXCLUDED.auth_kind,
        credentials=EXCLUDED.credentials,legacy_headers='{}',status=EXCLUDED.status,tools=CASE WHEN ${replacing || old?.name !== name} THEN '[]'::jsonb ELSE connector_accounts.tools END,
        revision=connector_accounts.revision+1,updated_at=now()`;

          if (replacing) yield* sql`DELETE FROM connector_oauth_states WHERE account_id=${id}::uuid`;

          return yield* view(yield* owned(user, id));
        }),
      ),
    access: (user: string, request: connectors.SetConnectorAccessRequest) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const row = yield* owned(user, request.accountId, true);

          if (BigInt(row.revision) !== request.expectedRevision)
            return yield* fail("Connector changed; reload and try again");

          if (request.workerIds.length > 256 || request.botIds.length > 256)
            return yield* fail("Too many connector grants");

          for (const id of new Set(request.workerIds))
            if (
              !(yield* sql`SELECT id FROM workers WHERE id=${id}::uuid AND (owner_user_id=${user}::uuid OR owner_user_id IS NULL) AND revoked_at IS NULL AND archived_at IS NULL`)
                .length
            )
              return yield* fail("Worker not found");

          for (const id of new Set(request.botIds))
            if (
              !(yield* sql`SELECT id FROM bots WHERE id=${id}::uuid AND owner_user_id=${user}::uuid AND deleted_at IS NULL`)
                .length
            )
              return yield* fail("Bot not found");
          yield* sql`UPDATE connector_accounts SET all_workers=${request.allWorkers},all_bots=${request.allBots},revision=revision+1,updated_at=now() WHERE id=${row.id}::uuid`;
          yield* sql`DELETE FROM connector_worker_grants WHERE account_id=${row.id}::uuid`;
          yield* sql`DELETE FROM connector_bot_grants WHERE account_id=${row.id}::uuid`;

          for (const id of new Set(request.workerIds))
            yield* sql`INSERT INTO connector_worker_grants(account_id,worker_id) VALUES (${row.id}::uuid,${id}::uuid)`;

          for (const id of new Set(request.botIds))
            yield* sql`INSERT INTO connector_bot_grants(account_id,bot_id) VALUES (${row.id}::uuid,${id}::uuid)`;
          yield* sql`UPDATE bots SET revision=revision+1 WHERE owner_user_id=${user}::uuid`;
          yield* audit({ userId: user, accountId: row.id }, "access", "updated");

          return yield* view(yield* owned(user, row.id));
        }),
      ),
    tools: (row: AccountRow): ConnectorTool[] => row.tools.map((t) => fromJson(ConnectorToolSchema, t)),
    saveTools: (row: AccountRow, tools: ConnectorTool[]) =>
      sql`UPDATE connector_accounts SET tools=${JSON.stringify(tools.map((t) => toJson(ConnectorToolSchema, t)))}::jsonb,status='connected' WHERE id=${row.id}::uuid AND revision=${BigInt(row.revision)}`,
    status: (row: AccountRow, status: string) =>
      sql`UPDATE connector_accounts SET status=${status} WHERE id=${row.id}::uuid AND revision=${BigInt(row.revision)}`,
    app: (user: string, type: string) =>
      sql<{
        credentials: Uint8Array;
      }>`SELECT credentials FROM connector_oauth_apps WHERE owner_user_id=${user}::uuid AND connector_type=${type}`.pipe(
        Effect.map((r) => (r[0] ? opened<OAuthClientInformationMixed>(r[0].credentials) : undefined)),
      ),
    appTypes: (user: string) =>
      sql<{
        connector_type: string;
      }>`SELECT connector_type FROM connector_oauth_apps WHERE owner_user_id=${user}::uuid`.pipe(
        Effect.map((r) => r.map((v) => v.connector_type)),
      ),
    saveApp: (user: string, request: connectors.SaveConnectorOAuthAppRequest) =>
      Effect.gen(function* () {
        if (
          !connectorType(request.connectorType) ||
          !request.clientId ||
          request.clientId.length > 2000 ||
          request.clientSecret.length > 32_000
        )
          return yield* fail("A connector type and OAuth client ID are required");
        const issuer = yield* checked(() => connectorUrl(request.issuer));
        const client = { client_id: request.clientId, client_secret: request.clientSecret || undefined, issuer };
        yield* sql`INSERT INTO connector_oauth_apps(owner_user_id,connector_type,credentials) VALUES (${user}::uuid,${request.connectorType},${encryptSecret(key, JSON.stringify(client))})
        ON CONFLICT(owner_user_id,connector_type) DO UPDATE SET credentials=EXCLUDED.credentials`;
      }),
    saveState: (user: string, row: AccountRow, state: string, binding: string, value: Credentials) =>
      Effect.gen(function* () {
        yield* sql`DELETE FROM connector_oauth_states WHERE expires_at < now() OR account_id=${row.id}::uuid`;
        yield* sql`INSERT INTO connector_oauth_states(state_hash,owner_user_id,account_id,browser_hash,credentials,account_revision,expires_at)
        VALUES (${digest(state)},${user}::uuid,${row.id}::uuid,${digest(binding)},${seal(value)},${BigInt(row.revision)},now()+interval '10 minutes')`;
      }),
    consumeState: (user: string, state: string, binding: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const row = (yield* sql<{
            account_id: string;
            credentials: Uint8Array;
            account_revision: bigint;
          }>`UPDATE connector_oauth_states SET consumed_at=now()
        WHERE state_hash=${digest(state)} AND owner_user_id=${user}::uuid AND browser_hash=${digest(binding)} AND consumed_at IS NULL AND expires_at>now() RETURNING account_id,credentials,account_revision`)[0];

          if (!row) {
            const used =
              yield* sql`SELECT 1 FROM connector_oauth_states WHERE state_hash=${digest(state)} AND owner_user_id=${user}::uuid AND browser_hash=${digest(binding)} AND consumed_at IS NOT NULL`;

            return yield* fail(
              used.length
                ? "OAuth callback was already used. Start sign-in again."
                : "OAuth session expired or does not match this browser. Reconnect the account.",
            );
          }

          return {
            accountId: row.account_id,
            revision: BigInt(row.account_revision),
            value: opened<Credentials>(row.credentials),
          };
        }),
      ),
    disconnect: (user: string, id: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const row = yield* owned(user, id, true);
          const value = yield* credentials(row);
          yield* sql`UPDATE connector_accounts SET status='disconnected',credentials=NULL,legacy_headers='{}',tools='[]',revision=revision+1,updated_at=now() WHERE id=${id}::uuid`;
          yield* sql`DELETE FROM connector_oauth_states WHERE account_id=${id}::uuid`;

          // Legacy encrypted headers have been copied by reference. Remove only this account's owned secret rows.
          for (const ref of Object.values(row.legacy_headers))
            yield* sql`DELETE FROM secrets WHERE id=${ref.secretRef}::uuid AND owner_user_id=${user}::uuid AND name LIKE 'bot-mcp-%'`;
          yield* audit({ userId: user, accountId: id }, "disconnect", "disconnected");

          return { row, value, account: yield* view(yield* owned(user, id)) };
        }),
      ),
    /** After disconnect: drop the account, its grants and replay records; audit rows stay, unlinked. */
    remove: (user: string, id: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* owned(user, id, true);
          yield* sql`UPDATE connector_audit SET account_id = NULL WHERE account_id=${id}::uuid`;
          yield* sql`DELETE FROM connector_executions WHERE account_id=${id}::uuid`;
          yield* sql`DELETE FROM connector_accounts WHERE id=${id}::uuid`;
          yield* sql`INSERT INTO connector_audit(owner_user_id,tool,outcome) VALUES (${user}::uuid,'delete','deleted')`;
        }),
      ),
    execution: (id: string) =>
      sql<{
        fingerprint: string;
        status: string;
        result: JsonValue | null;
      }>`SELECT fingerprint,status,result FROM connector_executions WHERE id=${id}::uuid`.pipe(Effect.map((r) => r[0])),
    claimExecution: (id: string, source: ExecutionSource, tool: string, fingerprint: string) =>
      sql`INSERT INTO connector_executions(id,account_id,owner_user_id,thread_id,bot_id,tool,fingerprint,status)
      VALUES (${id}::uuid,${source.accountId}::uuid,${source.userId}::uuid,${source.threadId ?? null}::uuid,${source.botId ?? null}::uuid,${tool},${fingerprint},'running') ON CONFLICT(id) DO NOTHING RETURNING id`.pipe(
        Effect.map((r) => r.length > 0),
      ),
    finishExecution: (id: string, source: ExecutionSource, tool: string, result: JsonValue, isError: boolean) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE connector_executions SET status=${isError ? "error" : "completed"},result=${JSON.stringify(result)}::jsonb,finished_at=now() WHERE id=${id}::uuid`;
          yield* sql`UPDATE connector_accounts SET last_used_at=now() WHERE id=${source.accountId}::uuid`;
          yield* audit(source, tool, isError ? "error" : "completed");
        }),
      ),
  };
}

export type ConnectorStore = ReturnType<typeof connectorStore>;
