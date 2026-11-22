import { Database } from "bun:sqlite";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { migrateEnrollmentSchema } from "./enrollment-schema.ts";
import { digest, type PushPlatform, type PushTarget } from "./protocol.ts";

const minute = 60_000;
const day = 24 * 60 * minute;
const challengeLifetime = 5 * minute;
const grantLifetime = 35 * day;
const attestationLifetime = 90 * day;
const maxChallenges = 4096;
const maxGrants = 50_000;
const maxTickets = 250_000;
const maxTicketsPerGrant = 512;

export interface ChallengeRequest extends PushTarget {
  binding: string;
}

export interface CompleteRequest {
  id: string;
  claim: string;
  attestation: string;
  keyId?: string;
}

interface Challenge {
  generation: number;
  proof_challenge: string;
  claim_hash: string;
  scope: string;
  binding: string;
  platform: PushPlatform;
  state: "pending" | "verifying" | "rejected" | "complete";
  proof_hash: string | null;
}

export interface Grant {
  id: string;
  scope: string;
  binding: string;
  platform: PushPlatform;
  generation: number;
  expires_at: number;
}

interface Credential {
  bearer: string;
  expiresAtMs: number;
}

type Reservation = { challenge: string; platform: PushPlatform } | { status: 403 | 409 } | Credential;

type GrantResult = Credential | { status: 403 | 503 };

export function pushScope({ platform, token }: PushTarget) {
  return digest(`canopy-push-target-v1\n${platform}\n${token}`);
}

export class EnrollmentStore {
  readonly #db: Database;
  readonly #key: string;
  #pruneAfter = 0;

  constructor(
    path: string,
    private readonly now: () => number = Date.now,
  ) {
    if (path !== ":memory:") closeSync(openSync(path, "a", 0o600));

    const db = new Database(path, { strict: true });

    try {
      db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;");
      migrateEnrollmentSchema(db, this.now() + grantLifetime);
      db.query("INSERT OR IGNORE INTO enrollment_secret (id, key) VALUES (1, ?)").run(randomSecret());
      const row = db.query<{ key: string }, []>("SELECT key FROM enrollment_secret WHERE id = 1").get();

      if (!row) throw new Error("Cannot load relay enrollment secret.");

      this.#key = row.key;
      this.#db = db;
    } catch (cause) {
      db.close();
      throw cause;
    }
  }

  close() {
    this.#db.close();
  }

  issue(request: ChallengeRequest) {
    const now = this.now();

    return this.#db
      .transaction(() => {
        this.#prune(now);
        const count = this.#db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM challenges").get();

        if (!count || count.count >= maxChallenges) return undefined;

        const id = randomUUID();
        const challenge = randomSecret();
        const claim = randomSecret();

        const proofChallenge = createHash("sha256")
          .update(`canopy-push-enrollment-v1\n${request.platform}\n${request.token}\n${challenge}`)
          .digest("base64url");

        this.#db
          .query(
            `INSERT INTO challenges (id, proof_challenge, claim_hash, scope, binding, platform, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            proofChallenge,
            digest(claim),
            pushScope(request),
            digest(request.binding),
            request.platform,
            now + challengeLifetime,
          );

        return { id, challenge, claim };
      })
      .immediate();
  }

  reserve(request: CompleteRequest): Reservation {
    const now = this.now();

    return this.#db
      .transaction((): Reservation => {
        const row = this.#challenge(request.id, now);

        if (!row || !timingSafeEqual(Buffer.from(row.claim_hash, "hex"), Buffer.from(digest(request.claim), "hex")))
          return { status: 403 };

        if (row.state === "verifying") return { status: 409 };

        if (row.state === "rejected") return { status: 403 };

        const proofHash = digest(JSON.stringify([request.attestation, request.keyId ?? null]));

        if (row.state === "complete") {
          const bearer = this.#bearer(request);
          const grant = this.#grant(digest(bearer), now);

          return grant && row.proof_hash === proofHash ? { bearer, expiresAtMs: grant.expires_at } : { status: 403 };
        }

        this.#db
          .query("UPDATE challenges SET state = 'verifying', proof_hash = ? WHERE id = ?")
          .run(proofHash, request.id);

        return { challenge: row.proof_challenge, platform: row.platform };
      })
      .immediate();
  }

  reject(id: string) {
    this.#db.query("UPDATE challenges SET state = 'rejected' WHERE id = ? AND state = 'verifying'").run(id);
  }

  grant(request: CompleteRequest): GrantResult {
    const now = this.now();
    const expiresAtMs = now + grantLifetime;

    return this.#db
      .transaction((): GrantResult => {
        const row = this.#challenge(request.id, now);

        if (row?.state !== "verifying") return { status: 403 };

        this.#prune(now);
        const existing = this.#db.query<Grant, [string]>("SELECT * FROM grants WHERE scope = ?").get(row.scope);

        if (existing && existing.generation >= row.generation) {
          this.reject(request.id);

          return { status: 403 };
        }

        if (!existing && !this.#canIssueGrant()) {
          this.reject(request.id);

          return { status: 503 };
        }

        const bearer = this.#bearer(request);

        if (existing && (existing.expires_at <= now || existing.binding !== row.binding))
          this.#db.query("DELETE FROM grants WHERE id = ?").run(existing.id);

        this.#db
          .query(
            `INSERT INTO grants (id, scope, binding, platform, generation, bearer_hash, expires_at, hard_expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(scope) DO UPDATE SET generation = excluded.generation, bearer_hash = excluded.bearer_hash,
             expires_at = excluded.expires_at, hard_expires_at = excluded.hard_expires_at`,
          )
          .run(
            randomUUID(),
            row.scope,
            row.binding,
            row.platform,
            row.generation,
            digest(bearer),
            expiresAtMs,
            now + attestationLifetime,
          );
        this.#db.query("UPDATE challenges SET state = 'complete' WHERE id = ?").run(request.id);

        return { bearer, expiresAtMs };
      })
      .immediate();
  }

  find(bearerHash: string): Grant | null {
    return this.#grant(bearerHash, this.now());
  }

  renew(bearerHash: string) {
    const now = this.now();

    const renewed = this.#db
      .query<{ expiresAtMs: number; reattest: number }, [number, string, number]>(
        `UPDATE grants SET expires_at = MIN(MAX(expires_at, ?1), hard_expires_at)
         WHERE bearer_hash = ?2 AND expires_at > ?3
         RETURNING expires_at AS expiresAtMs, ?1 >= hard_expires_at AS reattest`,
      )
      .get(now + grantLifetime, bearerHash, now);

    return renewed ? { expiresAtMs: renewed.expiresAtMs, ...(renewed.reattest === 1 && { reattest: true }) } : null;
  }

  revoke(bearerHash: string) {
    this.#db
      .transaction(() => {
        const revoked = this.#db
          .query<{ scope: string; generation: number }, [string]>(
            "DELETE FROM grants WHERE bearer_hash = ? RETURNING scope, generation",
          )
          .get(bearerHash);

        if (!revoked) return;

        // Older verifications in flight must not restore the revoked grant.
        this.#db
          .query("DELETE FROM challenges WHERE scope = ? AND generation <= ?")
          .run(revoked.scope, revoked.generation);
      })
      .immediate();
  }

  hasTicket(grant: Grant, ticketId: string) {
    return (
      this.#db
        .query<{ present: number }, [string, string, number]>(
          "SELECT 1 AS present FROM tickets WHERE grant_id = ? AND ticket_hash = ? AND expires_at > ?",
        )
        .get(grant.id, digest(ticketId), this.now()) !== null
    );
  }

  canSend(grant: Grant) {
    const now = this.now();

    this.#prune(now);

    return this.#hasTicketSpace(grant, now);
  }

  rememberTicket(grant: Grant, ticketId: string) {
    const now = this.now();

    return this.#db
      .transaction(() => {
        if (!this.#hasTicketSpace(grant, now)) return false;

        return (
          this.#db
            .query(
              `INSERT OR IGNORE INTO tickets (ticket_hash, grant_id, expires_at)
           SELECT ?, id, ? FROM grants WHERE id = ? AND expires_at > ?`,
            )
            .run(digest(ticketId), now + day, grant.id, now).changes === 1
        );
      })
      .immediate();
  }

  #challenge(id: string, now: number) {
    return this.#db
      .query<Challenge, [string, number]>("SELECT * FROM challenges WHERE id = ? AND expires_at > ?")
      .get(id, now);
  }

  #grant(bearerHash: string, now: number) {
    return this.#db
      .query<Grant, [string, number]>("SELECT * FROM grants WHERE bearer_hash = ? AND expires_at > ?")
      .get(bearerHash, now);
  }

  #canIssueGrant() {
    const count = this.#db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM grants").get();

    return count !== null && count.count < maxGrants;
  }

  #hasTicketSpace(grant: Grant, now: number) {
    const count = this.#db
      .query<{ total: number; per_grant: number }, [string, number]>(
        `SELECT (SELECT COUNT(*) FROM tickets) AS total,
                 (SELECT COUNT(*) FROM tickets WHERE grant_id = ? AND expires_at > ?) AS per_grant`,
      )
      .get(grant.id, now);

    return count !== null && count.total < maxTickets && count.per_grant < maxTicketsPerGrant;
  }

  #prune(now: number) {
    if (now < this.#pruneAfter) return;

    this.#db.query("DELETE FROM challenges WHERE expires_at <= ?").run(now);
    this.#db.query("DELETE FROM grants WHERE expires_at <= ?").run(now);
    this.#db.query("DELETE FROM tickets WHERE expires_at <= ?").run(now);
    this.#pruneAfter = now + minute;
  }

  #bearer({ id, claim }: CompleteRequest) {
    // A DB copy has the HMAC key and claim digests, but cannot reconstruct a live bearer without the raw claim.
    return createHmac("sha256", Buffer.from(this.#key, "base64url")).update(`${id}\n${claim}`).digest("base64url");
  }
}

function randomSecret() {
  return randomBytes(32).toString("base64url");
}
