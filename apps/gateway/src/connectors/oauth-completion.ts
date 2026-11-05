import type { connectors } from "@canopy/contracts";
import { isOAuthState, parsePastedCode } from "@canopy/domain/oauth-return";
import { Effect } from "effect";
import type { ConnectorsRuntime } from "./runtime.ts";
import { authorizeOAuth } from "./oauth.ts";
import { ConnectorOAuthFailure, oauthFailure } from "./oauth-error.ts";
import { connectorTestError } from "./test-error.ts";
import { McpFailure } from "../bots/mcp-errors.ts";

/** All returns share one claim/exchange path. A receipt confirms success without reusing authorization. */
export async function completeOAuth(
  runtime: Pick<ConnectorsRuntime, "run">,
  user: string,
  input: connectors.CompleteConnectorOAuthRequest,
) {
  const pasted = input.pastedCode ? parsePastedCode(input.pastedCode) : undefined;

  if (input.pastedCode && !pasted)
    throw oauthFailure("oauth_malformed", "This is not a sign-in code. Copy the code from the sign-in page.");
  const request = pasted ? { ...input, ...pasted, error: "", issuer: "" } : input;

  if (!isOAuthState(request.state) || request.code.length > 8000)
    throw oauthFailure("oauth_malformed", "This is not a sign-in code. Copy the code from the sign-in page.");

  if (!/^[\w-]{32,128}$/.test(request.browserBinding))
    throw oauthFailure(
      "oauth_binding",
      "This code belongs to another sign-in window. Use the window that started sign-in, or start again.",
    );
  const session = await runtime.run((s) => s.consumeState(user, request.state, request.browserBinding));

  if (session.used) {
    const account = await runtime.run((s) => s.owned(user, session.accountId).pipe(Effect.flatMap(s.view)));

    if (session.completed && account.status === "connected") return { account, alreadyConnected: true };
    throw oauthFailure("oauth_used", "This code was already used. Start sign-in again.");
  }

  if (request.error || !request.code)
    throw oauthFailure("oauth_declined", "Sign-in was declined. Start sign-in again when ready.");

  const account = await runtime.run((s) =>
    s.transaction(
      Effect.gen(function* () {
        const row = yield* s.owned(user, session.accountId, true);

        if (BigInt(row.revision) !== session.revision)
          return yield* Effect.fail(
            oauthFailure("oauth_changed", "This account changed during sign-in. Start sign-in again."),
          );
        const issuer = session.value.discovery?.authorizationServerMetadata?.issuer;

        if (request.issuer && request.issuer !== issuer)
          return yield* Effect.fail(
            oauthFailure("oauth_issuer", "The sign-in provider did not match. Start sign-in again."),
          );
        yield* Effect.tryPromise({
          try: () => authorizeOAuth(row.url, session.value, request.state, undefined, request.code),
          catch: (cause) => {
            const error = connectorTestError(
              cause instanceof McpFailure ? cause : new McpFailure("protocol", "oauth/token", 0, "invalid_response"),
              row.connector_type,
              session.value,
              [request.code, request.state],
            );

            return new ConnectorOAuthFailure(error.kind, error.message, error.detail);
          },
        });
        delete session.value.verifier;
        yield* s.updateCredentials(row, session.value, "connected");
        yield* s.completeState(user, request.state, request.browserBinding);
        yield* s.audit({ userId: user, accountId: row.id }, "oauth", "connected");

        return yield* s.view(yield* s.owned(user, row.id));
      }),
    ),
  );

  return { account, alreadyConnected: false };
}
