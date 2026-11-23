import { create } from "@bufbuild/protobuf";
import { connectors } from "@canopy/contracts";
import { isErrorObject } from "../core/error-cause.ts";
import { ConnectorFailure } from "./records.ts";
import type { OAuthNetworkFailure } from "./oauth-network.ts";

/** Only gateway-authored copy and redacted details cross the OAuth completion boundary. */
export class ConnectorOAuthFailure extends ConnectorFailure {
  readonly failure: connectors.ConnectorError;

  constructor(kind: string, message: string, detail = "") {
    super(message);
    this.failure = create(connectors.ConnectorErrorSchema, { kind, message, detail });
  }
}

export function connectorOAuthError(cause: unknown): connectors.ConnectorError {
  for (let current = cause, i = 0; i < 6 && isErrorObject(current); i++, current = current.cause) {
    if (current instanceof ConnectorOAuthFailure) return current.failure;
  }

  return create(connectors.ConnectorErrorSchema, {
    kind: "internal",
    message: "Sign-in could not finish. Start sign-in again.",
  });
}

export const oauthFailure = (kind: string, message: string) => new ConnectorOAuthFailure(kind, message);

export type OAuthStartStage = "discovery" | "registration" | "authorization" | "state";

/** Startup diagnostics must never carry a provider response, URL, or SQL error. */
export class OAuthStartFailure extends Error {
  constructor(
    readonly stage: OAuthStartStage,
    readonly status = 0,
    readonly network?: OAuthNetworkFailure,
  ) {
    super("OAuth start failed");
  }
}

export const oauthStartMessage: Record<OAuthStartStage, string> = {
  discovery: "Could not start OAuth. Check the server metadata.",
  registration: "Could not start OAuth. Check the OAuth client registration.",
  authorization: "Could not start OAuth. Check the OAuth configuration.",
  state: "Could not save the OAuth session. Try signing in again.",
};
