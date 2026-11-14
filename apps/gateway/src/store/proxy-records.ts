import { createHmac } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { Invalid, NotFound } from "./store.ts";
import { InstanceConflict } from "./instance-checks.ts";
import { decryptSecret } from "./secrets.ts";

export type ProxyOptions = {
  wireApi: string;
  supportsWebsockets: boolean;
  extraHeaders: Record<string, string>;
};

export interface ProxyRow {
  id: string;
  owner_user_id: string;
  name: string;
  kind: string;
  base_url: string;
  secret_id: string | null;
  management_secret_id: string | null;
  fingerprint: string;
  codex: ProxyOptions;
  revision: bigint | number | string;
}

export function proxyRoot(value: string): string {
  const url = URL.canParse(value.trim()) ? new URL(value.trim()) : undefined;

  if (!url || !["http:", "https:"].includes(url.protocol)) throw new Invalid("Use an http(s) proxy URL");

  if (url.username || url.password || url.search || url.hash)
    throw new Invalid("The proxy URL must not contain credentials, query parameters or a fragment");
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");

  return url.href.replace(/\/$/, "");
}

export const proxySupports = (kind: string, harness: string): boolean =>
  kind === "cliproxyapi" || (kind === "anthropic" ? harness === "claude" : harness === "codex" || harness === "grok");

export function proxyOptions(input?: ProxyOptions): ProxyOptions {
  const options = {
    wireApi: input?.wireApi || "responses",
    supportsWebsockets: input?.supportsWebsockets ?? false,
    extraHeaders: input?.extraHeaders ?? {},
  };

  if (options.wireApi !== "responses") throw new Invalid("This Codex version supports only the responses wire API");

  if (Object.keys(options.extraHeaders).length > 16) throw new Invalid("Use at most 16 extra headers");

  for (const [name, value] of Object.entries(options.extraHeaders)) {
    if (!/^[a-z0-9-]{1,80}$/i.test(name) || /authorization|key|token|secret|cookie|host/i.test(name))
      throw new Invalid("Extra headers must be public metadata; put credentials in Secret");

    if (value.length > 1024 || /[\r\n\0]/.test(value)) throw new Invalid("Invalid extra header value");
  }

  return options;
}

export const proxyFingerprint = (key: Buffer, root: string, secret: string): string =>
  createHmac("sha256", key).update(root).update("\0").update(secret).digest("hex");

export function proxyRecords(sql: SqlClient.SqlClient, key: Buffer) {
  const audit = (userId: string, id: string, action: string) =>
    sql`INSERT INTO audit_log (id, actor_user_id, action, target_type, target_id)
        VALUES (${Bun.randomUUIDv7()}::uuid, ${userId}::uuid, ${action}, 'proxy', ${id}::uuid)`;

  const get = (userId: string, id: string) =>
    Effect.gen(function* () {
      const row =
        (yield* sql<ProxyRow>`SELECT * FROM proxies WHERE owner_user_id = ${userId}::uuid AND id::text = ${id} FOR UPDATE`)[0];

      if (!row) return yield* Effect.fail(new NotFound("proxy not found"));

      return row;
    });

  const secret = (userId: string, secretId: string | null) =>
    Effect.gen(function* () {
      if (!secretId) return "";

      const row = (yield* sql<{ ciphertext: Uint8Array }>`SELECT ciphertext FROM secrets
      WHERE id = ${secretId}::uuid AND (owner_user_id = ${userId}::uuid OR owner_user_id IS NULL)`)[0];

      if (!row) return yield* Effect.fail(new NotFound("proxy secret not found"));

      return decryptSecret(key, row.ciphertext);
    });

  const usedBy = (id: string) =>
    Effect.gen(function* () {
      const instances = yield* sql<{
        label: string;
      }>`SELECT harness || '/' || id AS label FROM provider_instances WHERE proxy_id = ${id}::uuid
      UNION ALL SELECT w.harness || '/' || w.instance_id || ' on ' || d.name AS label
        FROM provider_instance_workers w JOIN workers d ON d.id = w.worker_id WHERE w.proxy_id = ${id}::uuid ORDER BY label`;

      return instances.map((i) => i.label);
    });

  const toUi = (row: ProxyRow) =>
    Effect.gen(function* () {
      return create(ui.ProxySchema, {
        id: row.id,
        name: row.name,
        kind: row.kind,
        baseUrl: row.base_url,
        secretSet: row.secret_id !== null,
        managementKeySet: row.management_secret_id !== null,
        codex: row.codex,
        revision: BigInt(row.revision),
        usedBy: yield* usedBy(row.id),
      });
    });

  const checkRevision = (row: ProxyRow, revision: bigint) =>
    revision !== 0n && revision !== BigInt(row.revision)
      ? Effect.fail(new InstanceConflict("The proxy changed meanwhile; reload and try again"))
      : Effect.void;

  return { audit, get, secret, usedBy, toUi, checkRevision };
}
