import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { github } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Schema } from "effect";

export const TokenPair = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAt: Schema.Number,
  refreshExpiresAt: Schema.Number,
  clientId: Schema.String,
});

export type TokenPair = typeof TokenPair.Type;

export interface AccountRow {
  id: string;
  owner_user_id: string;
  host: string;
  github_user_id: string;
  login: string;
  auth_kind: string;
  connector_account_id: string | null;
  connector_revision: bigint | null;
  status: string;
  credentials: Uint8Array | null;
  revision: bigint;
  refresh_lease: string | null;
  refresh_lease_until: Date | null;
  catalog_verified_at: Date | null;
}

export interface AttemptRow {
  id: string;
  owner_user_id: string;
  client_binding: string;
  client_request_id: string;
  client_id: string;
  state: string;
  device_code: Uint8Array | null;
  user_code: string;
  verification_uri: string;
  expires_at: Date;
  interval_seconds: number;
  next_poll_at: Date;
  lease_id: string | null;
  revision: bigint;
  account_id: string | null;
}

export const accountView = (row: AccountRow) =>
  create(github.GitHubAccountSchema, {
    id: row.id,
    githubUserId: row.github_user_id,
    login: row.login,
    host: row.host,
    authKind: row.auth_kind,
    status: row.status,
    revision: BigInt(row.revision),
    connectorAccountId: row.connector_account_id ?? "",
    ...(row.catalog_verified_at && { catalogVerifiedAt: timestampFromDate(new Date(row.catalog_verified_at)) }),
  });

export const attemptView = (row: AttemptRow) =>
  create(github.GitHubDeviceAuthSchema, {
    id: row.id,
    state: row.state,
    userCode: row.state === "pending" ? row.user_code : "",
    verificationUri: row.verification_uri,
    expiresAt: timestampFromDate(new Date(row.expires_at)),
    intervalSeconds: row.interval_seconds,
    accountId: row.account_id ?? "",
  });

export const notFound = () => new ConnectError("GitHub account or sign-in not found", Code.NotFound);

export const reconnect = () =>
  new ConnectError("GitHub access expired. Reconnect your account.", Code.FailedPrecondition);

export const uuid = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
