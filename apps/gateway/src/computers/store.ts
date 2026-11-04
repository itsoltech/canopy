import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { Code, ConnectError } from "@connectrpc/connect";
import { computerLink as link } from "@canopy/contracts";
import type { CoreRuntime } from "../core/core.ts";
import { encryptSecret, decryptSecret } from "../store/secrets.ts";
import { certificateIdentity, computerName, generateIdentity, hash, linkAddress } from "./identity.ts";
import { ROUTE_ORDER } from "./routes.ts";

export type IdentityRow = { node_id: string; name: string; certificate: string; private_key: Uint8Array; listener_enabled: boolean; lan_discovery: boolean };
export type PeerRow = {
  node_id: string; name: string; display_name: string; addresses: string[]; certificate: string; fingerprint: string;
  linked_at: Date; app_version: string; min_protocol: number; max_protocol: number; status: string;
  status_since: Date; last_seen: Date | null; update_node_id: string;
  capabilities: string[];
};
// A peer's addresses are its routes in the order connecting tries them (stage 6).
const PEERS = `SELECT p.*, COALESCE((SELECT jsonb_agg(address ORDER BY ${ROUTE_ORDER}) FROM computer_routes r
  WHERE r.owner_user_id=p.owner_user_id AND r.node_id=p.node_id), '[]'::jsonb) AS addresses FROM computer_peers p WHERE p.owner_user_id=$1::uuid`;
export class ComputerStore {
  constructor(readonly runtime: CoreRuntime, readonly owner: string, readonly key: Buffer) {}
  query<A extends object>(text: string, params: unknown[] = []) {
    return this.runtime.runPromise(Effect.gen(function* () { const sql = yield* SqlClient.SqlClient; return yield* sql.unsafe<A>(text, params); }));
  }
  async identity() {
    let row = (await this.query<IdentityRow>("SELECT * FROM computer_identity WHERE owner_user_id = $1::uuid", [this.owner]))[0];
    if (!row) {
      const identity = await generateIdentity();
      await this.query("INSERT INTO computer_identity (owner_user_id, node_id, name, certificate, private_key) VALUES ($1::uuid,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [this.owner, identity.nodeId, computerName(hostname()), identity.certificate, encryptSecret(this.key, identity.privateKey)]);
      row = (await this.query<IdentityRow>("SELECT * FROM computer_identity WHERE owner_user_id = $1::uuid", [this.owner]))[0];
    }
    if (!row) throw new Error("This gateway belongs to another owner");
    return { ...row, privateKey: decryptSecret(this.key, row.private_key), ...certificateIdentity(row.certificate) };
  }
  peers() { return this.query<PeerRow>(`${PEERS} ORDER BY p.linked_at`, [this.owner]); }
  async peer(nodeId: string) { return (await this.query<PeerRow>(`${PEERS} AND p.node_id=$2`, [this.owner, nodeId]))[0]; }
  async invitation(fingerprint: string, addresses: string[]) {
    const id = crypto.randomUUID(); const secret = randomBytes(16).toString("hex");
    // A new code revokes all outstanding invitations. No plaintext is persisted.
    const { owner } = this;
    await this.runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(Effect.gen(function* () {
        yield* sql`SELECT singleton FROM computer_identity WHERE owner_user_id=${owner}::uuid FOR UPDATE`;
        yield* sql`DELETE FROM computer_pairings WHERE owner_user_id=${owner}::uuid`;
        yield* sql`INSERT INTO computer_pairings (id,owner_user_id,secret_hash,expires_at) VALUES (${id}::uuid,${owner}::uuid,${hash(secret)},now()+interval '10 minutes')`;
      }));
    }));
    return { id, code: `${fingerprint}${secret}`.match(/.{8}/g)!.join("-"), expiresAtMs: BigInt(Date.now() + 600_000), addresses };
  }
  async pair(secret: string, hello: link.NodeHello, certificate: string) {
    const identity = certificateIdentity(certificate);
    this.validateHello(hello, identity.nodeId);
    const { owner } = this;
    // Commit failed attempts as well as successful exchanges. Locks serialize revoke/replay.
    const result = await this.runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql.withTransaction(Effect.gen(function* () {
        const budget = yield* sql<{ attempts: number }>`UPDATE computer_pairing_budget SET
          attempts=CASE WHEN window_start < clock_timestamp()-interval '1 minute' THEN 1 ELSE attempts+1 END,
          window_start=CASE WHEN window_start < clock_timestamp()-interval '1 minute' THEN clock_timestamp() ELSE window_start END RETURNING attempts`;
        if (budget[0]!.attempts > 30) return "limited";
        yield* sql`UPDATE computer_pairings SET attempts=attempts+1 WHERE owner_user_id=${owner}::uuid AND used_at IS NULL AND revoked_at IS NULL`;
        const rows = yield* sql`UPDATE computer_pairings SET used_at=clock_timestamp() WHERE owner_user_id=${owner}::uuid
          AND secret_hash=${hash(secret)} AND expires_at>clock_timestamp() AND used_at IS NULL AND revoked_at IS NULL AND attempts<=10 RETURNING id`;
        if (!rows.length) return "invalid";
        yield* sql`INSERT INTO computer_peers (owner_user_id,node_id,name,certificate,fingerprint,app_version,min_protocol,max_protocol)
          VALUES (${owner}::uuid,${identity.nodeId},${hello.name},${identity.certificate},${identity.fingerprint},${hello.appVersion},${hello.minProtocol},${hello.maxProtocol})
          ON CONFLICT (owner_user_id,node_id) DO UPDATE SET name=excluded.name,certificate=excluded.certificate,
          fingerprint=excluded.fingerprint,linked_at=now(),app_version=excluded.app_version,min_protocol=excluded.min_protocol,max_protocol=excluded.max_protocol`;
        for (const address of new Set(hello.addresses)) yield* sql`INSERT INTO computer_routes (owner_user_id,node_id,address,source)
          VALUES (${owner}::uuid,${identity.nodeId},${address},'announced') ON CONFLICT DO NOTHING`;
        yield* sql`DELETE FROM computer_revocations WHERE owner_user_id=${owner}::uuid AND node_id=${identity.nodeId}`;
        return "ok";
      }));
    }));
    if (result !== "ok") throw new ConnectError(result === "limited" ? "Too many pairing attempts. Try again in one minute." : "Pairing code is invalid, expired, revoked, exhausted or already used", result === "limited" ? Code.ResourceExhausted : Code.Unauthenticated);
  }
  validateHello(hello: link.NodeHello, nodeId: string) {
    if (hello.nodeId !== nodeId || hello.appVersion.length > 100 || hello.addresses.length > 16 || hello.capabilities.length > 32) throw new ConnectError("Invalid computer identity", Code.Unauthenticated);
    computerName(hello.name);
    for (const address of hello.addresses) linkAddress(address);
  }
  /** The address entered for pairing is a manual route that just worked; the partner's own addresses are announced. */
  async remember(hello: link.NodeHello, certificate: string, address: string, latencyMs: number) {
    const identity = certificateIdentity(certificate);
    this.validateHello(hello, identity.nodeId);
    await this.query(`INSERT INTO computer_peers (owner_user_id,node_id,name,certificate,fingerprint,app_version,min_protocol,max_protocol)
      VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (owner_user_id,node_id) DO UPDATE SET
      name=excluded.name,certificate=excluded.certificate,fingerprint=excluded.fingerprint,linked_at=now(),
      app_version=excluded.app_version,min_protocol=excluded.min_protocol,max_protocol=excluded.max_protocol`,
    [this.owner, identity.nodeId, hello.name, identity.certificate, identity.fingerprint, hello.appVersion, hello.minProtocol, hello.maxProtocol]);
    await this.query(`INSERT INTO computer_routes (owner_user_id,node_id,address,source,last_success,latency_ms) VALUES ($1::uuid,$2,$3,'manual',now(),$4)
      ON CONFLICT (owner_user_id,node_id,address) DO UPDATE SET source='manual',last_success=now(),latency_ms=excluded.latency_ms`, [this.owner, identity.nodeId, address, Math.round(latencyMs)]);
    await this.query(`INSERT INTO computer_routes (owner_user_id,node_id,address,source) SELECT $1::uuid,$2,a,'announced' FROM unnest($3::text[]) AS a ON CONFLICT DO NOTHING`,
      [this.owner, identity.nodeId, [...new Set(hello.addresses)]]);
    await this.query("DELETE FROM computer_revocations WHERE owner_user_id=$1::uuid AND node_id=$2", [this.owner, identity.nodeId]);
  }
  async remove(nodeId: string, revoke: boolean) {
    const { owner } = this;
    await this.runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(Effect.gen(function* () {
        yield* sql`DELETE FROM computer_peers WHERE owner_user_id=${owner}::uuid AND node_id=${nodeId}`;
        if (revoke) yield* sql`INSERT INTO computer_revocations (owner_user_id,node_id) VALUES (${owner}::uuid,${nodeId}) ON CONFLICT DO NOTHING`;
      }));
    }));
  }
  async status(nodeId: string, status: string, updateNodeId = "") {
    await this.query(`UPDATE computer_peers SET status=$3, status_since=CASE WHEN status<>$3 THEN now() ELSE status_since END,
      last_seen=CASE WHEN $3 IN ('connected','needs_update','updating','sleeping','shutting_down') THEN now() ELSE last_seen END,
      update_node_id=$4 WHERE owner_user_id=$1::uuid AND node_id=$2`, [this.owner, nodeId, status, updateNodeId]);
  }
}
