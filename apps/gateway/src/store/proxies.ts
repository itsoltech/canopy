import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { Invalid } from "./store.ts";
import { InstanceConflict, type Fx } from "./instance-checks.ts";
import type { InstanceCore } from "./instance-queries.ts";
import { configTransaction, recordProviders } from "../config-sync/provider-records.ts";
import {
  proxyFingerprint,
  proxyOptions,
  proxyRecords,
  proxyRoot,
  proxySupports,
  type ProxyRow,
} from "./proxy-records.ts";

export interface ProxyApi {
  listProxies(userId: string): Fx<ui.Proxy[]>;
  saveProxy(userId: string, request: ui.SaveProxyRequest): Fx<{ proxy: ui.Proxy; changed: string[] }>;
  deleteProxy(userId: string, request: ui.ProxyIdRequest): Fx<void>;
  testProxy(userId: string, request: ui.ProxyIdRequest): Fx<ui.TestProxyResponse>;
}

/** Public metadata only. Upstream response bodies and fetch exceptions never become UI diagnostics. */
async function probe(row: ProxyRow, key: string): Promise<ui.TestProxyResponse> {
  try {
    const response = await fetch(`${row.base_url}/v1/models`, {
      headers:
        row.kind === "anthropic"
          ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
          : { ...row.codex.extraHeaders, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });

    if (!response.ok) {
      await response.body?.cancel();

      return create(ui.TestProxyResponseSchema, { detail: `Proxy returned HTTP ${response.status}` });
    }

    // Decode at the boundary. Only model count and positive product markers leave this function.
    const body = Schema.decodeUnknownSync(Schema.JsonObject)(await response.json());
    const models = body["data"];

    if (!Array.isArray(models))
      return create(ui.TestProxyResponseSchema, { detail: "The endpoint did not return a model list" });
    const marker = `${response.headers.get("server") ?? ""} ${response.headers.get("x-powered-by") ?? ""} ${response.headers.get("x-cliproxyapi-version") ?? ""}`;

    const detected =
      /cliproxyapi/i.test(marker) ||
      response.headers.has("x-cliproxyapi-version") ||
      (await detectCliProxy(row.base_url));

    return create(ui.TestProxyResponseSchema, {
      ok: true,
      modelCount: models.length,
      cliproxyapiDetected: detected,
      detail: detected ? "CLIProxyAPI detected" : "Connected",
    });
  } catch {
    return create(ui.TestProxyResponseSchema, {
      detail: "Could not read the proxy model list; check its URL, key and network access",
    });
  }
}

/** CLIProxyAPI's public root identifies the product. This request deliberately carries no credential. */
async function detectCliProxy(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(2000), redirect: "error" });

    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
      await response.body?.cancel();

      return false;
    }

    const body = Schema.decodeUnknownSync(Schema.JsonObject)(await response.json());

    return body["message"] === "CLI Proxy API Server";
  } catch {
    return false;
  }
}

export function proxyStore(sql: SqlClient.SqlClient, key: Buffer, core: InstanceCore): ProxyApi {
  const records = proxyRecords(sql, key);

  return {
    listProxies: (userId) =>
      Effect.gen(function* () {
        const rows =
          yield* sql<ProxyRow>`SELECT * FROM proxies WHERE owner_user_id = ${userId}::uuid ORDER BY name, id`;

        return yield* Effect.forEach(rows, records.toUi);
      }),
    saveProxy: (userId, request) =>
      configTransaction(
        sql,
        Effect.gen(function* () {
          const previous = request.id ? yield* records.get(userId, request.id) : undefined;

          if (previous) yield* records.checkRevision(previous, request.expectedRevision);
          const name = request.name.trim();

          if (!name || name.length > 80)
            return yield* Effect.fail(new Invalid("Give the proxy a name of at most 80 characters"));

          if (!["cliproxyapi", "anthropic", "openai"].includes(request.kind))
            return yield* Effect.fail(new Invalid("Choose a proxy kind"));

          const root = yield* Effect.try({
            try: () => proxyRoot(request.baseUrl),
            catch: () => new Invalid("Use an http(s) URL without credentials, query or fragment"),
          });

          const options = yield* Effect.try({
            try: () => proxyOptions(request.kind, request.codex ?? previous?.codex),
            catch: (e) => (e instanceof Invalid ? e : new Invalid("Invalid transport options")),
          });

          const id = previous?.id ?? Bun.randomUUIDv7();
          const secret = request.secret ?? (previous ? yield* records.secret(userId, previous.secret_id) : "");

          if (!secret || secret.length > 16384 || /[\r\n\0]/.test(secret))
            return yield* Effect.fail(new Invalid("Enter a valid proxy secret"));

          const uses = yield* sql<{
            harness: string;
          }>`SELECT harness FROM provider_instances WHERE proxy_id = ${id}::uuid
        UNION SELECT harness FROM provider_instance_workers WHERE proxy_id = ${id}::uuid`;

          if (uses.some((u) => !proxySupports(request.kind, u.harness)))
            return yield* Effect.fail(new InstanceConflict("This kind does not support every profile using the proxy"));

          const ref =
            request.secret !== undefined || !previous?.secret_id
              ? yield* core.putSecret(userId, secret)
              : { secretRef: previous.secret_id };

          const fingerprint = proxyFingerprint(key, root, secret);

          if (previous) {
            yield* sql`UPDATE proxies SET name = ${name}, kind = ${request.kind}, base_url = ${root}, secret_id = ${ref.secretRef}::uuid,
          fingerprint = ${fingerprint}, codex = ${JSON.stringify(options)}::jsonb, revision = revision + 1, updated_at = now()
          WHERE id = ${id}::uuid AND owner_user_id = ${userId}::uuid`;
          } else {
            yield* sql`INSERT INTO proxies (id, owner_user_id, name, kind, base_url, secret_id, fingerprint, codex)
          VALUES (${id}::uuid, ${userId}::uuid, ${name}, ${request.kind}, ${root}, ${ref.secretRef}::uuid, ${fingerprint}, ${JSON.stringify(options)}::jsonb)`;
          }

          yield* records.audit(userId, id, previous ? "proxy.updated" : "proxy.created");

          if (previous && request.secret !== undefined) yield* records.audit(userId, id, "proxy.secret_replaced");
          const changed = yield* core.sync(userId);

          return { proxy: yield* records.toUi(yield* records.get(userId, id)), changed };
        }),
      ),
    deleteProxy: (userId, request) =>
      configTransaction(
        sql,
        Effect.gen(function* () {
          const row = yield* records.get(userId, request.id);
          yield* records.checkRevision(row, request.expectedRevision);
          const uses = yield* records.usedBy(row.id);

          if (uses.length)
            return yield* Effect.fail(
              new InstanceConflict(
                `Proxy is used by: ${uses.join(", ")}. Choose another proxy in these profiles first.`,
              ),
            );
          yield* sql`DELETE FROM proxies WHERE id = ${row.id}::uuid AND owner_user_id = ${userId}::uuid`;
          yield* records.audit(userId, row.id, "proxy.deleted");
          yield* core.dropUnusedSecrets();
          yield* recordProviders(sql);
        }),
      ),
    testProxy: (userId, request) =>
      Effect.gen(function* () {
        const row = yield* records.get(userId, request.id);
        const secret = yield* records.secret(userId, row.secret_id);

        return yield* Effect.promise(() => probe(row, secret));
      }),
  };
}

export { proxySupports, proxyRecords };
