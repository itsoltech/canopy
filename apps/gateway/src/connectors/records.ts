import { type JsonValue } from "@bufbuild/protobuf";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { createHash } from "node:crypto";
import { Effect } from "effect";

export class ConnectorFailure extends Error {}

/** A saved OAuth app; `redirect_uri` is the fixed redirect URL it was registered with, if any. */
export type RegisteredApp = OAuthClientInformationMixed & { issuer?: string; redirect_uri?: string };

export interface Credentials {
  headers?: Record<string, string>;
  tokens?: OAuthTokens;
  client?: OAuthClientInformationMixed;
  discovery?: OAuthDiscoveryState;
  verifier?: string;
  /** The exact redirect used to register this client and start its pending code exchange. */
  redirectUri?: string;
  expiresAt?: number;
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
  all_workers: boolean;
  all_bots: boolean;
  revision: bigint | string;
  tools: JsonValue[];
  last_used_at: Date | null;
}

export interface ExecutionSource {
  userId: string;
  accountId: string;
  workerId?: string;
  threadId?: string;
  turnId?: string;
  botId?: string;
  readOnlyOnly?: boolean;
}

export const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export const fail = (message: string) => Effect.fail(new ConnectorFailure(message));

export const checked = <A>(run: () => A) =>
  Effect.try({ try: run, catch: () => new ConnectorFailure("Invalid connector configuration") });
