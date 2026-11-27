import { Schema } from "effect";
import { decryptSecret } from "../store/secrets.ts";
import type { MessengerProvider } from "./provider.ts";
import type { MessengerAccount } from "./types.ts";

export interface AccountRow {
  id: string;
  owner_user_id: string;
  name: string;
  provider: MessengerProvider;
  external_id: string;
  connector_account_id: string | null;
  connector_client_id: string | null;
  connector_team_id: string | null;
  enabled: boolean;
  status: string;
  credentials: Uint8Array;
  revision: string | bigint;
  refresh_attempt: string | null;
  refresh_started_at: Date | null;
}

const decode = Schema.decodeUnknownSync(
  Schema.Struct({
    appToken: Schema.String,
    botToken: Schema.String,
    refreshToken: Schema.optional(Schema.String),
    expiresAt: Schema.optional(Schema.Number),
    clientId: Schema.optional(Schema.String),
    appId: Schema.optional(Schema.String),
    teamId: Schema.optional(Schema.String),
  }),
);

export const openMessengerCredentials = (key: Buffer, row: AccountRow) =>
  decode(JSON.parse(decryptSecret(key, row.credentials)));

export const accountView = (row: AccountRow): MessengerAccount => ({
  id: row.id,
  ownerUserId: row.owner_user_id,
  name: row.name,
  provider: row.provider,
  externalId: row.external_id,
  connectorAccountId: row.connector_account_id ?? "",
  requiresSlackUser: row.connector_client_id !== null,
  enabled: row.enabled,
  status: row.status,
});
