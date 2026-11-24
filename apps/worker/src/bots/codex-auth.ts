import { Effect } from "effect";
import type { CodexAppServer, ServerRequestHandler } from "../providers/codex/app-server.ts";
import { readCodexBotAuthRoute, type CodexBotAuthRoute } from "../providers/codex/bot-auth-route.ts";
import { codexBotLoginScope, type CodexBotLoginScope } from "../providers/codex/profile-auth.ts";
import { BotHarnessFailure, type BotHarnessContext } from "./types.ts";

/** A bot process owns one turn. Only its selected profile may renew that turn's identity. */
export function codexBotAuth(ctx: BotHarnessContext) {
  let loginScope: CodexBotLoginScope | undefined;
  let destination: CodexBotAuthRoute | undefined;
  const denied = () => new BotHarnessFailure("auth_required", "Could not use the selected Codex login.");

  const login = (server: CodexAppServer["Service"]) =>
    Effect.gen(function* () {
      if (ctx.profile.kind !== "native" || !ctx.session.linkLogin) return;
      const read = ctx.codexLogin;

      if (!read) return yield* Effect.fail(denied());
      const route = yield* readCodexBotAuthRoute(server, ctx.session.cwd).pipe(Effect.mapError(denied));
      const credential = yield* Effect.tryPromise({ try: () => read(route), catch: denied });

      if (ctx.signal.aborted) return yield* Effect.fail(denied());

      const scope = codexBotLoginScope(credential);

      if (credential.type === "chatgptAuthTokens" && !scope) return yield* Effect.fail(denied());

      const result = yield* server.request("account/login/start", credential).pipe(Effect.mapError(denied));

      if (credential.type !== result.type) return yield* Effect.fail(denied());

      destination = route;
      loginScope = scope;
    });

  const onServerRequest: ServerRequestHandler = async (request) => {
    if (request.method !== "account/chatgptAuthTokens/refresh")
      throw new Error("Bots have no native tools or interactions");

    const scope = loginScope;

    if (!scope || !destination || !ctx.codexLogin || ctx.signal.aborted) throw denied();

    if (request.params.previousAccountId != null && request.params.previousAccountId !== scope.chatgptAccountId)
      throw denied();

    const next = await ctx.codexLogin(destination, scope).catch(() => {
      throw denied();
    });

    const nextScope = codexBotLoginScope(next);

    if (
      ctx.signal.aborted ||
      next.type !== "chatgptAuthTokens" ||
      nextScope?.chatgptAccountId !== scope.chatgptAccountId ||
      nextScope.chatgptUserId !== scope.chatgptUserId ||
      nextScope.accessTokenDigest === scope.accessTokenDigest
    )
      throw denied();

    loginScope = nextScope;

    return {
      accessToken: next.accessToken,
      chatgptAccountId: nextScope.chatgptAccountId,
      chatgptPlanType: next.chatgptPlanType ?? null,
    };
  };

  return { login, onServerRequest };
}
