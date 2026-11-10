import { Schema, Effect } from "effect";
import type { GitHubStore } from "./store.ts";
import { GitHubHttp, GitHubHttpFailure } from "./http.ts";
import { reconnect, type AccountRow, type TokenPair } from "./records.ts";
import { TokenResponse } from "./schemas.ts";

export type RunGitHub = <A, E>(use: (store: GitHubStore) => Effect.Effect<A, E>) => Promise<A>;

export interface AccessToken {
  row: AccountRow;
  token: string;
  secrets?: readonly string[];
}

export function tokenPair(value: typeof TokenResponse.Type, clientId: string, now: number): TokenPair {
  if (value.token_type.toLowerCase() !== "bearer") throw reconnect();

  return {
    accessToken: value.access_token,
    refreshToken: value.refresh_token,
    clientId,
    expiresAt: now + value.expires_in * 1000,
    refreshExpiresAt: now + value.refresh_token_expires_in * 1000,
  };
}

/** One local flight; SQL fencing serializes the rotating pair across gateway processes. */
export class GitHubAccess {
  #refreshes = new Map<string, Promise<AccessToken>>();
  constructor(
    readonly run: RunGitHub,
    readonly http: GitHubHttp,
    readonly owner: string,
    readonly pat: (row: AccountRow) => Promise<string>,
  ) {}

  async token(id: string, forceRevision?: bigint): Promise<AccessToken> {
    const row = await this.run((s) => s.owned(this.owner, id));

    if (row.status !== "connected") throw reconnect();

    if (row.auth_kind === "pat") return { row, token: await this.pat(row) };
    const tokens = await this.run((s) => Effect.sync(() => s.open(row)));

    if (!row.refresh_lease && tokens.expiresAt > this.http.now() + 300_000 && row.revision !== forceRevision)
      return { row, token: tokens.accessToken, secrets: [tokens.refreshToken] };
    const old = this.#refreshes.get(id);

    if (old) return old;
    const promise = this.#refresh(id, forceRevision);
    this.#refreshes.set(id, promise);

    try {
      return await promise;
    } finally {
      this.#refreshes.delete(id);
    }
  }
  async #refresh(id: string, forceRevision?: bigint): Promise<AccessToken> {
    const deadline = Date.now() + 31_000;

    while (Date.now() < deadline) {
      const row = await this.run((s) => s.owned(this.owner, id));

      if (row.status !== "connected" || !row.credentials) throw reconnect();
      const tokens = await this.run((s) => Effect.sync(() => s.open(row)));
      const now = this.http.now();

      if (row.refresh_lease) {
        // SAFETY: the database enforces refresh_lease and refresh_lease_until as an inseparable pair.
        if (Number(new Date(row.refresh_lease_until!)) <= now) {
          await this.run((s) => s.clearRevision(row));
          throw reconnect();
        }

        await Bun.sleep(50);
        continue;
      }

      if (tokens.expiresAt > now + 300_000 && row.revision !== forceRevision)
        return { row, token: tokens.accessToken, secrets: [tokens.refreshToken] };

      if (tokens.refreshExpiresAt <= now) {
        await this.run((s) => s.clearRevision(row));
        throw reconnect();
      }

      const lease = Bun.randomUUIDv7();

      if (!(await this.run((s) => s.refreshClaim(row, lease, now))).length) continue;

      try {
        const response = await this.http.post("/login/oauth/access_token", {
          client_id: tokens.clientId,
          grant_type: "refresh_token",
          refresh_token: tokens.refreshToken,
        });

        const pair = tokenPair(Schema.decodeUnknownSync(TokenResponse)(response), tokens.clientId, this.http.now());
        const saved = (await this.run((s) => s.refreshFinish(row, lease, pair, this.http.now())))[0];

        if (!saved) throw reconnect();

        return { row: saved, token: pair.accessToken, secrets: [pair.refreshToken] };
      } catch {
        // A timeout can mean GitHub rotated the pair. Never reuse the previous refresh token.
        await this.run((s) => s.clearRevision(row));
        throw reconnect();
      }
    }

    throw reconnect();
  }
  async get(id: string, path: string, signal?: AbortSignal) {
    return this.authorized(id, (access) => this.http.get(path, access.token, signal, access.secrets));
  }
  async authorized<A>(id: string, use: (access: AccessToken) => Promise<A>) {
    let access = await this.token(id);

    try {
      const value = await use(access);
      await this.#valid(access.row);

      return { value, row: access.row };
    } catch (cause) {
      if (!(cause instanceof GitHubHttpFailure) || cause.status !== 401) throw cause;
    }

    if (access.row.auth_kind === "pat") {
      await this.run((s) => s.clearRevision(access.row));
      throw reconnect();
    }

    access = await this.token(id, access.row.revision);

    try {
      const value = await use(access);
      await this.#valid(access.row);

      return { value, row: access.row };
    } catch (cause) {
      if (cause instanceof GitHubHttpFailure && cause.status === 401) {
        await this.run((s) => s.clearRevision(access.row));
        throw reconnect();
      }

      throw cause;
    }
  }
  async #valid(row: AccountRow) {
    const current = await this.run((s) => s.owned(this.owner, row.id));

    if (current.status !== "connected" || current.revision !== row.revision) throw reconnect();
  }
}
