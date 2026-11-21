import { pinnedCertificate } from "@canopy/transport";
import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { databaseUrl } from "../database-credentials.ts";
import { networkPort } from "../runtime.ts";
import { CutoverError } from "./cutover-files.ts";
import type { CutoverHost } from "./cutover-host.ts";
import type { CutoverRoutes, DesktopCutoverDevice } from "./cutover-protocol.ts";
import { inspectDatabase } from "./postgres.ts";

export function cutoverRoutes(host: CutoverHost, fingerprint: string | null): CutoverRoutes | undefined {
  if (!fingerprint || host.networkOrigins.length === 0) return undefined;

  return { fingerprint, addresses: host.networkOrigins };
}

export async function readCutoverRoutes(host: CutoverHost) {
  if (host.networkOrigins.length === 0) return undefined;
  const snapshot = await inspectDatabase(host.env);

  return cutoverRoutes(host, snapshot.certificateSha256);
}

function localNetworkPort(host: CutoverHost) {
  const origin = host.networkOrigins[0];

  if (!origin) throw new CutoverError("Configure a pinned Network access origin for this Desktop migration.");

  return networkPort(host.env) ?? Number(new URL(origin).port || 443);
}

export async function verifyCutoverRoutes(host: CutoverHost, routes: CutoverRoutes) {
  const port = localNetworkPort(host);

  try {
    await pinnedCertificate(`https://127.0.0.1:${port}`, routes.fingerprint, AbortSignal.timeout(5000));
  } catch {
    throw new CutoverError("The destination Network access listener did not present the restored certificate.");
  }
}

export async function installDesktopDevice(host: CutoverHost, device: DesktopCutoverDevice) {
  const port = localNetworkPort(host);
  const email = host.env["CANOPY_DEV_USER_EMAIL"] ?? "dev@localhost";

  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SET LOCAL synchronous_commit = on`;
          yield* sql`WITH added AS (
          INSERT INTO public.mobile_devices (id, owner_user_id, name, platform, token_hash, pairing_version, client_kind)
          SELECT ${device.id}::uuid, id, ${device.name}, ${device.platform}, ${device.tokenHash}, 2, 'desktop'
          FROM public.users WHERE email = ${email}
          ON CONFLICT DO NOTHING
          RETURNING id, owner_user_id
        )
        INSERT INTO public.audit_log (id, actor_user_id, action, target_type, target_id)
        SELECT ${Bun.randomUUIDv7()}::uuid, owner_user_id, 'desktop.pair', 'mobile_device', id FROM added`;

          const [match] = yield* sql<{ accepted: boolean }>`SELECT EXISTS(
          SELECT FROM public.mobile_devices d JOIN public.users u ON d.owner_user_id=u.id
          WHERE d.id = ${device.id}::uuid AND u.email = ${email} AND d.name = ${device.name}
            AND d.platform = ${device.platform} AND d.token_hash = ${device.tokenHash}
            AND d.revoked_at IS NULL AND d.client_kind='desktop' AND d.pairing_version=2
        ) AS accepted`;

          if (!match?.accepted)
            return yield* Effect.fail(new CutoverError("The target could not register this Desktop."));

          yield* sql`INSERT INTO public.network_access (owner_user_id, enabled, port)
          SELECT id, true, ${port} FROM public.users WHERE email = ${email}
          ON CONFLICT (singleton) DO UPDATE SET enabled = true, port = excluded.port, updated_at = now()
          WHERE network_access.owner_user_id = excluded.owner_user_id`;
        }),
      );
    }).pipe(
      Effect.provide(
        PgClient.layer({
          url: Redacted.make(databaseUrl(host.env)),
          applicationName: "canopy-migration-desktop",
        }),
      ),
    ),
  );
}
