import { createHash, randomBytes } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, createContextKey, type ConnectRouter } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { CoreRuntime } from "./core.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const uuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export const mobileIdentity = createContextKey<{ deviceId: string; userId: string } | undefined>(undefined);
type DeviceRow = { id: string; name: string; platform: string; created_at: Date; last_seen_at: Date | null; revoked_at: Date | null };
type PairingRow = { id: string; expires_at: Date; used_at: Date | null; revoked_at: Date | null; device_id: string | null };
const device = (row: DeviceRow) => create(ui.MobileDeviceSchema, {
  id: row.id, name: row.name, platform: row.platform, createdAt: timestampFromDate(new Date(row.created_at)),
  ...(row.last_seen_at && { lastSeenAt: timestampFromDate(new Date(row.last_seen_at)) }),
  ...(row.revoked_at && { revokedAt: timestampFromDate(new Date(row.revoked_at)) }),
});
const pairing = (row: PairingRow) => create(ui.MobilePairingSchema, {
  id: row.id, expiresAt: timestampFromDate(new Date(row.expires_at)), deviceId: row.device_id ?? "",
  ...(row.used_at && { usedAt: timestampFromDate(new Date(row.used_at)) }),
  ...(row.revoked_at && { revokedAt: timestampFromDate(new Date(row.revoked_at)) }),
});

/** Keep SQL/driver diagnostics away from the pairing and bearer-secret boundary. */
export async function mobileGuard<A>(run: () => Promise<A>): Promise<A> {
  try { return await run(); }
  catch (error) {
    if (error instanceof ConnectError) throw error;
    throw new ConnectError("Mobile device operation failed. Refresh and try again.", Code.FailedPrecondition);
  }
}

export class MobileDevices {
  #window = 0;
  #attempts = 0;
  readonly #streams = new Map<string, Set<AbortController>>();
  constructor(readonly options: { runtime: CoreRuntime; userId: string; gatewayUrl?: string; publish: (update: ui.OverviewUpdate) => void }) {
    if (options.gatewayUrl) {
      const url = new URL(options.gatewayUrl);
      if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
        throw new Error("CANOPY_MOBILE_GATEWAY_URL must be an HTTPS origin (private Tailscale Serve URL)");
      }
    }
  }

  routes = (router: ConnectRouter) => router.service(ui.MobilePairingService, {
    exchangeMobilePairing: (request) => mobileGuard(() => this.exchange(request)),
  });

  async list() {
    const { runtime, userId, gatewayUrl } = this.options;
    return runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const devices = yield* sql<DeviceRow>`SELECT * FROM mobile_devices WHERE owner_user_id = ${userId}::uuid ORDER BY created_at DESC`;
      const pairings = yield* sql<PairingRow>`SELECT * FROM mobile_pairings WHERE owner_user_id = ${userId}::uuid
        AND created_at > now() - interval '1 day' ORDER BY created_at DESC LIMIT 100`;
      return create(ui.GetMobileDevicesResponseSchema, { gatewayUrl: gatewayUrl ?? "", devices: devices.map(device), pairings: pairings.map(pairing) });
    }));
  }

  async create() {
    const { runtime, userId, gatewayUrl } = this.options;
    // Hex avoids modulo bias and is easy to type: 16 characters = 64 random bits.
    const raw = randomBytes(8).toString("hex").toUpperCase();
    const code = raw.match(/.{4}/g)!.join("-");
    const row = await runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql.withTransaction(Effect.gen(function* () {
        yield* sql`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
        const pending = yield* sql`SELECT id FROM mobile_pairings WHERE owner_user_id = ${userId}::uuid
          AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()`;
        if (pending.length >= 20) return yield* Effect.fail(new Error("too many invitations"));
        const rows = yield* sql<PairingRow>`INSERT INTO mobile_pairings (id, owner_user_id, code_hash, expires_at)
          VALUES (${Bun.randomUUIDv7()}::uuid, ${userId}::uuid, ${digest(raw)}, now() + interval '10 minutes') RETURNING *`;
        yield* sql`INSERT INTO audit_log (id, actor_user_id, action, target_type, target_id)
          VALUES (${Bun.randomUUIDv7()}::uuid, ${userId}::uuid, 'mobile.pairing.create', 'mobile_pairing', ${rows[0]!.id}::uuid)`;
        return rows[0]!;
      }));
    }));
    const value = pairing(row);
    this.options.publish(create(ui.OverviewUpdateSchema, { change: { case: "mobilePairing", value } }));
    return create(ui.CreateMobilePairingResponseSchema, { pairing: value, code, gatewayUrl: gatewayUrl ?? "" });
  }

  async exchange(request: ui.ExchangeMobilePairingRequest) {
    // Global process budget: proxy headers and caller-supplied codes cannot reset it.
    const now = Date.now();
    if (now - this.#window >= 60_000) { this.#window = now; this.#attempts = 0; }
    if (++this.#attempts > 30) throw new ConnectError("Too many pairing attempts. Try again in one minute.", Code.ResourceExhausted);
    const invalid = () => new ConnectError("Pairing code is invalid, expired, revoked or already used", Code.Unauthenticated);
    const code = request.code.replace(/[\s-]/g, "").toUpperCase();
    if (!/^[A-F0-9]{16}$/.test(code)) throw invalid();
    const name = request.name.trim();
    if (!name || name.length > 100 || /[\p{Cc}]/u.test(name) || !["ios", "android"].includes(request.platform)) {
      throw new ConnectError("Enter a device name (1–100 characters) and a supported platform", Code.InvalidArgument);
    }
    const { runtime, userId } = this.options;
    const token = `oa_device_${randomBytes(32).toString("base64url")}`;
    const result = await runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql.withTransaction(Effect.gen(function* () {
        const rows = yield* sql<PairingRow>`SELECT * FROM mobile_pairings WHERE code_hash = ${digest(code)}
          AND owner_user_id = ${userId}::uuid AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now() FOR UPDATE`;
        const row = rows[0];
        if (!row) return undefined;
        const eligible = yield* sql`SELECT id FROM mobile_pairings WHERE id = ${row.id}::uuid AND expires_at > clock_timestamp()`;
        if (!eligible.length) return undefined;
        const devices = yield* sql<DeviceRow>`INSERT INTO mobile_devices (id, owner_user_id, name, platform, token_hash, last_seen_at)
          VALUES (${Bun.randomUUIDv7()}::uuid, ${userId}::uuid, ${name}, ${request.platform}, ${digest(token)}, now()) RETURNING *`;
        const paired = yield* sql<PairingRow>`UPDATE mobile_pairings SET used_at = clock_timestamp(), device_id = ${devices[0]!.id}::uuid
          WHERE id = ${row.id}::uuid RETURNING *`;
        yield* sql`INSERT INTO audit_log (id, actor_user_id, action, target_type, target_id)
          VALUES (${Bun.randomUUIDv7()}::uuid, ${userId}::uuid, 'mobile.pair', 'mobile_device', ${devices[0]!.id}::uuid)`;
        return { device: device(devices[0]!), pairing: pairing(paired[0]!) };
      }));
    }));
    if (!result) throw invalid();
    this.options.publish(create(ui.OverviewUpdateSchema, { change: { case: "mobilePairing", value: result.pairing } }));
    this.options.publish(create(ui.OverviewUpdateSchema, { change: { case: "mobileDevice", value: result.device } }));
    return create(ui.ExchangeMobilePairingResponseSchema, { device: result.device, deviceToken: token });
  }

  async authenticate(token: string) {
    if (!/^oa_device_[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const { runtime, userId } = this.options;
    return mobileGuard(() => runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // Check revocation on every RPC; only write last_seen once per minute.
      const rows = yield* sql<{ id: string }>`SELECT id FROM mobile_devices WHERE token_hash = ${digest(token)}
        AND owner_user_id = ${userId}::uuid AND revoked_at IS NULL`;
      const row = rows[0];
      if (!row) return undefined;
      yield* sql`UPDATE mobile_devices SET last_seen_at = now() WHERE id = ${row.id}::uuid
        AND (last_seen_at IS NULL OR last_seen_at < now() - interval '1 minute')`;
      return { deviceId: row.id, userId };
    })));
  }

  /** Revoke cancels already open streams as well as denying the next RPC. Single gateway process. */
  track(id: string, controller: AbortController): () => void {
    let set = this.#streams.get(id);
    if (!set) { set = new Set(); this.#streams.set(id, set); }
    set.add(controller);
    return () => { set.delete(controller); if (!set.size) this.#streams.delete(id); };
  }

  async revoke(id: string, kind: "device" | "pairing") {
    if (!uuid(id)) throw new ConnectError("Device or invitation not found", Code.NotFound);
    const { runtime, userId } = this.options;
    const result = await runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql.withTransaction(Effect.gen(function* () {
        const rows = kind === "device"
          ? yield* sql<DeviceRow>`UPDATE mobile_devices SET revoked_at = coalesce(revoked_at, now()) WHERE id = ${id}::uuid AND owner_user_id = ${userId}::uuid RETURNING *`
          : yield* sql<PairingRow>`UPDATE mobile_pairings SET revoked_at = coalesce(revoked_at, now()) WHERE id = ${id}::uuid AND owner_user_id = ${userId}::uuid AND used_at IS NULL RETURNING *`;
        if (!rows.length) return undefined;
        yield* sql`INSERT INTO audit_log (id, actor_user_id, action, target_type, target_id)
          VALUES (${Bun.randomUUIDv7()}::uuid, ${userId}::uuid, ${`mobile.${kind}.revoke`}, ${`mobile_${kind}`}, ${id}::uuid)`;
        return rows[0];
      }));
    }));
    if (!result) throw new ConnectError("Device or pending invitation not found", Code.NotFound);
    if (kind === "device") {
      for (const controller of this.#streams.get(id) ?? []) controller.abort(new ConnectError("Device revoked", Code.Unauthenticated));
      this.#streams.delete(id);
      this.options.publish(create(ui.OverviewUpdateSchema, { change: { case: "mobileDevice", value: device(result as DeviceRow) } }));
    } else this.options.publish(create(ui.OverviewUpdateSchema, { change: { case: "mobilePairing", value: pairing(result as PairingRow) } }));
  }
}
