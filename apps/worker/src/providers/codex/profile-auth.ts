import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Effect, Fiber, Option, Predicate, Schema, Semaphore } from "effect";
import { CodexAppServer, type CodexAppServerOptions } from "./app-server.ts";
import { checkCodexBotAuthRoute, type CodexBotAuthRoute } from "./bot-auth-route.ts";
import { RpcError } from "./rpc.ts";

type ChatgptBotLogin = {
  type: "chatgptAuthTokens";
  accessToken: string;
  chatgptAccountId: string;
  chatgptPlanType?: string | null;
};

export type CodexBotLogin = ChatgptBotLogin | { type: "apiKey"; apiKey: string };

export interface CodexBotLoginScope {
  readonly chatgptAccountId: string;
  readonly chatgptUserId: string;
  readonly accessTokenDigest: string;
}

const credential = Schema.String.check(Schema.makeFilter((value) => /^\S+$/u.test(value)));
const optionalClaim = Schema.optionalKey(Schema.NullOr(credential));
const authNamespace = "https://api.openai.com/auth";

const JwtClaims = Schema.Struct({
  [authNamespace]: Schema.Struct({
    chatgpt_account_id: credential,
    chatgpt_user_id: optionalClaim,
    user_id: optionalClaim,
  }),
  exp: Schema.optionalKey(Schema.Int),
});

const AuthStatus = Schema.Struct({
  requiresOpenaiAuth: Schema.Literal(true),
  authMethod: Schema.Literals(["apikey", "chatgpt"]),
  authToken: credential,
});

function chatgptClaims(accessToken: string) {
  const payload = /^[\w-]+\.([\w-]+)\.[\w-]+$/u.exec(accessToken)?.[1];

  if (!payload) return undefined;

  try {
    const body = Buffer.from(payload, "base64url");

    if (body.toString("base64url") !== payload) return undefined;

    const claims = Option.getOrUndefined(
      Schema.decodeUnknownOption(JwtClaims)(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body))),
    );

    if (!claims) return undefined;
    const { chatgpt_account_id: accountId, chatgpt_user_id: userId, user_id: alternateId } = claims[authNamespace];
    const identity = userId ?? alternateId;

    if (!identity || (userId && alternateId && userId !== alternateId) || identity === accountId) return undefined;

    const scope: CodexBotLoginScope = {
      chatgptAccountId: accountId,
      chatgptUserId: identity,
      accessTokenDigest: createHash("sha256").update(accessToken).digest("hex"),
    };

    return { scope, exp: claims.exp };
  } catch {
    return undefined;
  }
}

/** Identifies the owner and rejected access token without including the token in a refresh request. */
export function codexBotLoginScope(login: CodexBotLogin): CodexBotLoginScope | undefined {
  if (login.type !== "chatgptAuthTokens") return undefined;
  const scope = chatgptClaims(login.accessToken)?.scope;

  return scope?.chatgptAccountId === login.chatgptAccountId ? scope : undefined;
}

const unavailable = () =>
  new Error("The selected Codex profile has no supported bot login. Check its sign-in and CLI version.");

const refreshFailed = () => new Error("The selected Codex profile could not renew its ChatGPT access.");

function readLogin(codex: CodexAppServer["Service"], refresh: boolean) {
  return codex.request("getAuthStatus", { includeToken: true, refreshToken: refresh }).pipe(
    Effect.timeout("60 seconds"),
    Effect.mapError(refresh ? refreshFailed : unavailable),
    Effect.map((response) => Option.getOrUndefined(Schema.decodeUnknownOption(AuthStatus)(response))),
  );
}

function chatgptLogin(status: typeof AuthStatus.Type | undefined) {
  if (status?.authMethod !== "chatgpt") return undefined;
  const claims = chatgptClaims(status.authToken);

  if (!claims) return undefined;

  const login: ChatgptBotLogin = {
    type: "chatgptAuthTokens",
    accessToken: status.authToken,
    chatgptAccountId: claims.scope.chatgptAccountId,
  };

  return { login, scope: claims.scope, usable: claims.exp === undefined || claims.exp > Date.now() / 1000 };
}

const sameOwner = (first: CodexBotLoginScope, second: CodexBotLoginScope) =>
  first.chatgptAccountId === second.chatgptAccountId && first.chatgptUserId === second.chatgptUserId;

const sameLookup = (first?: CodexBotLoginScope, second?: CodexBotLoginScope) =>
  first && second ? sameOwner(first, second) && first.accessTokenDigest === second.accessTokenDigest : first === second;

function lookupLogin(
  codex: CodexAppServer["Service"],
  destination: CodexBotAuthRoute,
  scope?: CodexBotLoginScope,
): Effect.Effect<CodexBotLogin, Error> {
  return Effect.gen(function* () {
    yield* checkCodexBotAuthRoute(codex, destination);
    const status = yield* readLogin(codex, false);

    if (!scope && status?.authMethod === "apikey") return { type: "apiKey", apiKey: status.authToken };
    const initial = chatgptLogin(status);

    if (!scope) return initial?.usable ? initial.login : yield* Effect.fail(unavailable());

    if (!initial || !sameOwner(initial.scope, scope)) return yield* Effect.fail(refreshFailed());

    // Another bot or CLI may already have renewed the access rejected by the bot.
    if (initial.usable && initial.scope.accessTokenDigest !== scope.accessTokenDigest) return initial.login;
    const current = chatgptLogin(yield* readLogin(codex, true));

    // getAuthStatus can return its old token when the forced refresh failed transiently.
    if (
      !current?.usable ||
      !sameOwner(current.scope, scope) ||
      current.scope.accessTokenDigest === initial.scope.accessTokenDigest ||
      current.scope.accessTokenDigest === scope.accessTokenDigest
    )
      return yield* Effect.fail(refreshFailed());

    return current.login;
  });
}

interface LoginBatch {
  readonly destination: CodexBotAuthRoute;
  readonly requested: CodexBotLoginScope | undefined;
  readonly fiber: Fiber.Fiber<CodexBotLogin, Error>;
}

/** Open the selected profile's auth store afresh, since the thread process may cache a signed-out login. */
export const profileBotLogin = ({ launch, clientVersion }: Pick<CodexAppServerOptions, "launch" | "clientVersion">) =>
  Effect.gen(function* () {
    const lifetime = yield* Effect.scope;
    const admission = yield* Semaphore.make(1);
    let active: LoginBatch | undefined;

    const probe = CodexAppServer.layer({
      launch,
      clientVersion,
      processKind: "probe",
      onServerRequest: async () => {
        throw new RpcError("auth lookup", -32601, "Unavailable during Codex authentication lookup");
      },
    });

    function startBatch(destination: CodexBotAuthRoute, requested?: CodexBotLoginScope) {
      return Effect.gen(function* () {
        if (Predicate.isTagged("Closed")(lifetime.state)) return yield* Effect.fail(unavailable());

        if (active) return active;

        const fiber = yield* CodexAppServer.use((codex) => lookupLogin(codex, destination, requested)).pipe(
          Effect.provide(probe, { local: true }),
          Effect.catchTag("CodexAppServerStartupError", () => Effect.fail(unavailable())),
          Effect.catchDefect(() => Effect.fail(unavailable())),
          Effect.ensuring(
            Effect.sync(() => {
              active = undefined;
            }).pipe(admission.withPermit),
          ),
          Effect.forkIn(lifetime),
        );

        active = { destination, requested, fiber };

        return active;
      }).pipe(admission.withPermit, Effect.uninterruptible);
    }

    const botLogin = (
      destination: CodexBotAuthRoute,
      requested?: CodexBotLoginScope,
    ): Effect.Effect<CodexBotLogin, Error> =>
      startBatch(destination, requested).pipe(
        Effect.flatMap((batch) =>
          sameLookup(requested, batch.requested) && isDeepStrictEqual(destination, batch.destination)
            ? Fiber.join(batch.fiber)
            : Fiber.await(batch.fiber).pipe(Effect.andThen(Effect.suspend(() => botLogin(destination, requested)))),
        ),
      );

    return botLogin;
  });
