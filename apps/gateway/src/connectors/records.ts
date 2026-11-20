import { type JsonValue } from "@bufbuild/protobuf";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { createHash } from "node:crypto";
import { Effect } from "effect";

export class ConnectorFailure extends Error {}

/** A saved OAuth app; `redirect_uri` is the fixed redirect URL it was registered with, if any. */
export type RegisteredApp = OAuthClientInformationMixed & { issuer?: string; redirect_uri?: string };

export interface Credentials {
  /** Issuer and principal digest from an authenticated token endpoint, versioned for config sync. */
  oauthSubject?: string;
  /** An explicitly configured origin that resolved publicly during sign-in must stay public on callback and refresh. */
  oauthPublicOrigins?: string[];
  slackTeamId?: string;
  slackMessaging?: { accountId: string; revision: string; clientId: string };
  headers?: Record<string, string>;
  tokens?: OAuthTokens;
  client?: OAuthClientInformationMixed;
  discovery?: OAuthDiscoveryState;
  verifier?: string;
  /** The exact redirect used to register this client and start its pending code exchange. */
  redirectUri?: string;
  expiresAt?: number;
  /** Hash of provider-supplied account metadata, captured before the SDK strips token extensions. */
  accountIdentity?: string;
}

export function oauthIdentityChanged(previous: Credentials | undefined, next: Credentials | undefined): boolean {
  if (previous?.oauthSubject && next?.oauthSubject) return previous.oauthSubject !== next.oauthSubject;

  return !!previous?.accountIdentity && !!next?.accountIdentity && previous.accountIdentity !== next.accountIdentity;
}

export interface AccountRow {
  id: string;
  owner_user_id: string;
  connector_type: string;
  name: string;
  namespace: string;
  url: string;
  transport: string;
  auth_kind: string;
  credentials: Uint8Array | null;
  legacy_headers: Record<string, { secretRef: string }>;
  status: string;
  error: JsonValue | null;
  all_workers: boolean;
  all_bots: boolean;
  revision: bigint | string;
  tools: JsonValue[];
  last_used_at: Date | null;
  slack_team_id?: string | null;
  slack_refresh_attempt?: string | null;
  slack_refresh_started_at?: Date | null;
}

export interface ExecutionSource {
  userId: string;
  accountId: string;
  workerId?: string;
  threadId?: string;
  turnId?: string;
  botId?: string;
  botLease?: string;
  readOnlyOnly?: boolean;
}

export const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export const fail = (message: string) => Effect.fail(new ConnectorFailure(message));

export const checked = <A>(run: () => A) =>
  Effect.try({ try: run, catch: () => new ConnectorFailure("Invalid connector configuration") });
