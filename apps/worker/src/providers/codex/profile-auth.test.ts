import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs, waitForProcessStopped } from "@canopy/testing";
import type { JsonValue } from "@canopy/domain";
import { Effect, Schema } from "effect";
import type { CodexBotAuthRoute } from "./bot-auth-route.ts";
import { codexBotLoginScope, profileBotLogin } from "./profile-auth.ts";

const tempDir = tempDirs();
const namespace = "https://api.openai.com/auth";

const jwt = (claims: Record<string, string>, nonce = "first") =>
  `e30.${Buffer.from(JSON.stringify({ [namespace]: claims, jti: nonce })).toString("base64url")}.fixture`;

const claims = { chatgpt_account_id: "workspace-a", chatgpt_user_id: "user-a" };
const valid = jwt(claims);
const rejected = codexBotLoginScope({ type: "chatgptAuthTokens", accessToken: valid, chatgptAccountId: "workspace-a" });

if (!rejected) throw new Error("The fake login is missing an owner");

const destination: CodexBotAuthRoute = {
  openaiBaseUrl: null,
  chatgptBaseUrl: "https://chatgpt.com/backend-api/",
  modelCatalogUrl: null,
};

const status = (authToken: string | null, authMethod: string | null = "chatgpt", requiresOpenaiAuth = true) => ({
  authToken,
  authMethod,
  requiresOpenaiAuth,
});

const Trace = Schema.fromJsonString(Schema.Struct({ pid: Schema.Int, method: Schema.String, refresh: Schema.Boolean }));

function fixture(version = "0.172.0") {
  const root = tempDir("canopy-profile-auth-");

  const service = profileBotLogin({
    clientVersion: "test",
    launch: {
      command: [process.execPath, join(import.meta.dir, "fixtures/profile-auth.ts"), root],
      env: { CODEX_HOME: root, CODEX_FIXTURE_VERSION: version },
    },
  });

  return {
    service,
    set: (
      first: ReturnType<typeof status>,
      renewed?: ReturnType<typeof status>,
      options?: { rpcError?: boolean; sessions?: JsonValue; sessionError?: { code: number; message: string } },
    ) => writeFileSync(join(root, "fixture.json"), JSON.stringify({ status: first, renewed, ...options })),
    trace: () =>
      readFileSync(join(root, "requests.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => Schema.decodeSync(Trace)(line)),
  };
}

test("selected Codex credentials are reread in a fresh process after sign-out", async () => {
  const probe = fixture();
  probe.set(status(valid));
  await Effect.runPromise(
    Effect.gen(function* () {
      const readLogin = yield* probe.service;
      const first = yield* readLogin(destination);
      expect(first.type === "chatgptAuthTokens" && first.accessToken === valid).toBe(true);
      const owner = codexBotLoginScope(first);
      expect(owner?.chatgptAccountId).toBe("workspace-a");
      expect(owner?.chatgptUserId).toBe("user-a");

      probe.set(status(null, null));
      const signedOut = yield* Effect.flip(readLogin(destination));
      expect(signedOut.message).toContain("no supported bot login");
      const trace = probe.trace();
      const initialized = trace.filter((call) => call.method === "initialize");
      expect(initialized).toHaveLength(2);

      for (const { pid } of initialized) yield* Effect.promise(() => waitForProcessStopped(pid));
    }).pipe(Effect.scoped),
  );
});

test("concurrent Codex refreshes share one probe and renewal on a profile", async () => {
  const probe = fixture();
  const renewed = jwt(claims, "second");
  probe.set(status(valid), status(renewed));
  await Effect.runPromise(
    Effect.gen(function* () {
      const readLogin = yield* probe.service;

      const [first, second] = yield* Effect.all([readLogin(destination, rejected), readLogin(destination, rejected)], {
        concurrency: "unbounded",
      });

      expect(first.type === "chatgptAuthTokens" && first.accessToken === renewed).toBe(true);
      expect(second.type === "chatgptAuthTokens" && second.accessToken === renewed).toBe(true);
      expect(probe.trace().map(({ method, refresh }) => [method, refresh])).toEqual([
        ["initialize", false],
        ["config/read", false],
        ["configRequirements/read", false],
        ["accountSession/list", false],
        ["getAuthStatus", false],
        ["getAuthStatus", true],
      ]);
    }).pipe(Effect.scoped),
  );
});

test("Codex 0.172 preflights the stored account even when the access claims match the bot", async () => {
  const probe = fixture();

  const selected = {
    sessionId: "session-a",
    isActive: true,
    selectedWorkspaceAccountId: "workspace-a",
    userId: "user-a",
  };

  await Effect.runPromise(
    Effect.gen(function* () {
      const readLogin = yield* probe.service;

      for (const sessions of [
        [{ ...selected, userId: "user-b" }],
        [{ ...selected, selectedWorkspaceAccountId: "workspace-b" }],
        [{ ...selected, userId: null }],
        [selected, { ...selected, sessionId: "also-active" }],
      ]) {
        probe.set(status(valid), undefined, { sessions: { activeSessionId: selected.sessionId, sessions } });
        const error = yield* Effect.flip(readLogin(destination, rejected));
        expect(error.message).toContain("could not renew");
      }

      expect(probe.trace().filter((call) => call.method === "accountSession/list")).toHaveLength(4);
      expect(probe.trace().some((call) => call.method === "getAuthStatus")).toBe(false);
    }).pipe(Effect.scoped),
  );
});

test("only confirmed unsupported account session listing on Codex 0.164 permits legacy renewal", async () => {
  const old = fixture("0.164.0");
  const modern = fixture();
  const renewed = jwt(claims, "renewed");

  const unsupported = {
    code: -32600,
    message: "Invalid request: unknown variant `accountSession/list`, expected one of `initialize`",
  };

  await Effect.runPromise(
    Effect.gen(function* () {
      const legacyLogin = yield* old.service;
      const modernLogin = yield* modern.service;
      old.set(status(valid), status(renewed), { sessionError: { code: -32600, message: "Unrelated bad request" } });
      modern.set(status(valid), status(renewed), { sessionError: unsupported });
      yield* Effect.flip(legacyLogin(destination, rejected));
      yield* Effect.flip(modernLogin(destination, rejected));
      expect(old.trace().some((call) => call.method === "getAuthStatus")).toBe(false);
      expect(modern.trace().some((call) => call.method === "getAuthStatus")).toBe(false);

      old.set(status(valid), status(renewed), { sessionError: unsupported });
      const login = yield* legacyLogin(destination, rejected);
      expect(login.type === "chatgptAuthTokens" && login.accessToken === renewed).toBe(true);
      expect(old.trace().filter((call) => call.method === "getAuthStatus")).toHaveLength(2);
    }).pipe(Effect.scoped),
  );
});

test("Codex refresh rejects unchanged access, sign-out, and a different workspace or user", async () => {
  const probe = fixture();
  await Effect.runPromise(
    Effect.gen(function* () {
      const readLogin = yield* probe.service;

      for (const next of [
        status(valid),
        status(null, null),
        status(jwt({ ...claims, chatgpt_account_id: "workspace-b" })),
        status(jwt({ ...claims, chatgpt_user_id: "user-b" })),
        status(jwt({ ...claims, user_id: "conflicting-user" }, "second")),
        status(jwt({ chatgpt_account_id: "workspace-a" }, "second")),
      ]) {
        probe.set(status(valid), next);
        const error = yield* Effect.flip(readLogin(destination, rejected));
        expect(error.message).toBe("The selected Codex profile could not renew its ChatGPT access.");
      }
    }).pipe(Effect.scoped),
  );
});

test("Codex reuses already rotated access and refuses to force refresh for a different owner", async () => {
  const probe = fixture();
  const otherToken = jwt(claims, "externally-rotated");
  probe.set(status(otherToken));
  await Effect.runPromise(
    Effect.gen(function* () {
      const readLogin = yield* probe.service;
      const reused = yield* readLogin(destination, rejected);
      expect(reused.type === "chatgptAuthTokens" && reused.accessToken === otherToken).toBe(true);

      for (const first of [
        status(null, null),
        status(jwt({ ...claims, chatgpt_account_id: "workspace-b" })),
        status(jwt({ ...claims, chatgpt_user_id: "user-b" })),
      ]) {
        probe.set(first);
        const error = yield* Effect.flip(readLogin(destination, rejected));
        expect(error.message).toContain("could not renew");
      }

      expect(probe.trace().filter((call) => call.refresh)).toEqual([]);
    }).pipe(Effect.scoped),
  );
});

test("a Codex credential read cannot share a batch across different destination routes", async () => {
  const probe = fixture();
  probe.set(status(valid));
  await Effect.runPromise(
    Effect.gen(function* () {
      const readLogin = yield* probe.service;
      const mismatched = { ...destination, chatgptBaseUrl: "https://example.invalid/backend-api/" };

      const [login, error] = yield* Effect.all([readLogin(destination), Effect.flip(readLogin(mismatched))], {
        concurrency: "unbounded",
      });

      expect(login.type === "chatgptAuthTokens" && login.accessToken === valid).toBe(true);
      expect(error.message).toContain("authentication route");
      expect(probe.trace().filter((call) => call.method === "getAuthStatus")).toHaveLength(1);
    }).pipe(Effect.scoped),
  );
});

test("Codex fails closed for unsupported modes, versions, and malformed credentials", async () => {
  const probe = fixture();
  await Effect.runPromise(
    Effect.gen(function* () {
      const readLogin = yield* probe.service;

      for (const first of [
        status(" ", "apikey"),
        status(valid, "chatgptAuthTokens"),
        status(valid, "chatgpt", false),
        status(jwt({ chatgpt_user_id: "user-a" })),
        status(jwt({ chatgpt_account_id: "user-a", chatgpt_user_id: "user-a" })),
      ]) {
        probe.set(first);
        expect((yield* Effect.flip(readLogin(destination))).message).toContain("no supported bot login");
      }

      probe.set(status(valid), undefined, { rpcError: true });
      const error = yield* Effect.flip(readLogin(destination));
      expect(error.message).toContain("CLI version");
      expect(error.stack?.includes("fixture private credential") ?? false).toBe(false);

      probe.set(status("synthetic-key", "apikey"));
      const key = yield* readLogin(destination);
      expect(key.type === "apiKey" && key.apiKey === "synthetic-key").toBe(true);
    }).pipe(Effect.scoped),
  );
});
