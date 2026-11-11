import { create } from "@bufbuild/protobuf";
import { github } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect, Match, Schema } from "effect";
import { attemptView, uuid, type AttemptRow } from "./records.ts";
import { DeviceResponse, OAuthError, TokenResponse, User } from "./schemas.ts";
import { GitHubHttp } from "./http.ts";
import { tokenPair, type RunGitHub } from "./access.ts";

export class GitHubDeviceFlow {
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | undefined;
  #stopped = false;
  #starting = new Map<string, Promise<github.GitHubDeviceAuthResponse>>();
  constructor(
    readonly run: RunGitHub,
    readonly http: GitHubHttp,
    readonly owner: string,
    readonly connected: (id: string) => Promise<void>,
  ) {}

  start() {
    if (this.#timer || !this.http.config.configured) return;
    this.#stopped = false;
    this.#timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, 1000);
    this.#timer.unref();
    void this.tick().catch(() => {});
  }
  async stop() {
    this.#stopped = true;
    clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }
  tick() {
    if (this.#stopped) return Promise.resolve();

    return (this.#running ??= this.#tick().finally(() => {
      this.#running = undefined;
    }));
  }
  async begin(request: github.BeginGitHubDeviceAuthRequest) {
    if (!this.http.config.configured) return create(github.GitHubDeviceAuthResponseSchema, { configured: false });

    if (!uuid(request.clientRequestId)) throw new ConnectError("Start a new GitHub sign-in.", Code.InvalidArgument);
    const key = `${request.clientBinding}/${request.clientRequestId}`;
    const old = this.#starting.get(key);

    if (old) return old;
    const promise = this.#begin(request);
    this.#starting.set(key, promise);

    try {
      return await promise;
    } finally {
      this.#starting.delete(key);
    }
  }
  async #begin(request: github.BeginGitHubDeviceAuthRequest) {
    const previous = (
      await this.run((s) => s.previousAttempt(this.owner, request.clientBinding, request.clientRequestId))
    )[0];

    if (previous) return this.get(previous.id, request.clientBinding);

    const value = Schema.decodeUnknownSync(DeviceResponse)(
      await this.http.post("/login/device/code", { client_id: this.http.config.clientId }),
    );

    if (
      value.interval > 3600 ||
      value.expires_in > 3600 ||
      value.user_code.length > 32 ||
      value.device_code.length > 1024
    )
      throw new Error("Invalid device flow limits");
    const now = this.http.now();

    const row = await this.run((s) =>
      s.saveAttempt(
        this.owner,
        request.clientBinding,
        request.clientRequestId,
        this.http.config.clientId,
        {
          deviceCode: value.device_code,
          userCode: value.user_code,
          verificationUri: value.verification_uri,
          expiresAt: now + value.expires_in * 1000,
          interval: value.interval,
        },
        now,
      ),
    );

    return create(github.GitHubDeviceAuthResponseSchema, { configured: true, attempt: attemptView(row) });
  }
  async get(id: string, client: string, cancel = false) {
    if (!uuid(id)) throw new ConnectError("GitHub sign-in not found", Code.NotFound);
    let row = await this.run((s) => s.attempt(this.owner, id, client));

    if (row.state === "pending" && (cancel || Number(new Date(row.expires_at)) <= this.http.now())) {
      await this.run((s) => s.stopAttempt(this.owner, id, client, cancel ? "cancelled" : "expired"));
      row = await this.run((s) => s.attempt(this.owner, id, client));
    }

    return create(github.GitHubDeviceAuthResponseSchema, {
      configured: this.http.config.configured,
      attempt: attemptView(row),
    });
  }
  async #tick() {
    await this.run((s) => s.expireAttempts(this.owner, this.http.now()));

    if (!this.http.config.configured) return;

    // Bounded work per wake-up; leases also fence a second gateway process.
    for (let count = 0; count < 2 && !this.#stopped; count++) {
      const row = await this.run((s) => s.claimAttempt(this.owner, this.http.now()));

      if (!row) return;

      try {
        await this.#poll(row);
      } catch {
        await this.run((s) => s.finish(row, "failed"));
      }
    }
  }
  async #poll(row: AttemptRow) {
    const code = await this.run((s) => Effect.sync(() => s.deviceCode(row)));

    const response = await this.http.post("/login/oauth/access_token", {
      client_id: row.client_id,
      device_code: code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });

    if (Schema.is(OAuthError)(response)) {
      const error = Schema.decodeUnknownSync(OAuthError)(response).error;

      if (error === "authorization_pending" || error === "slow_down")
        await this.run((s) => s.pendingAttempt(row, error === "slow_down", this.http.now()));
      else
        await this.run((s) =>
          s.finish(
            row,
            Match.value(error).pipe(
              Match.when("expired_token", () => "expired"),
              Match.when("access_denied", () => "denied"),
              Match.orElse(() => "failed"),
            ),
          ),
        );

      return;
    }

    const tokens = tokenPair(Schema.decodeUnknownSync(TokenResponse)(response), row.client_id, this.http.now());

    const user = Schema.decodeUnknownSync(User)(
      await this.http.get("/user", tokens.accessToken, undefined, [tokens.refreshToken]),
    );

    const account = await this.run((s) => s.connectAttempt(row, String(user.id), user.login, tokens, this.http.now()));

    if (account) void this.connected(account.id).catch(() => {});
  }
}
