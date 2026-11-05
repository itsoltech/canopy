import { Schema } from "effect";
import {
  OAuthClientInformationSchema,
  OAuthMetadataSchema,
  OAuthProtectedResourceMetadataSchema,
  OAuthTokensSchema,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Credentials } from "./records.ts";

const decode = Schema.decodeUnknownSync(
  Schema.Struct({
    headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    tokens: Schema.optional(Schema.JsonObject),
    client: Schema.optional(Schema.JsonObject),
    discovery: Schema.optional(
      Schema.Struct({
        authorizationServerUrl: Schema.String,
        authorizationServerMetadata: Schema.optional(Schema.JsonObject),
        resourceMetadata: Schema.optional(Schema.JsonObject),
        resourceMetadataUrl: Schema.optional(Schema.String),
      }),
    ),
    redirectUri: Schema.optional(Schema.String),
    expiresAt: Schema.optional(Schema.Number),
    accountIdentity: Schema.optional(Schema.String),
  }),
);

/** The linked gateway is a data boundary too. PKCE verifiers are never part of shared credentials. */
export function sharedCredentials(plain: string): Credentials {
  const raw = Schema.decodeUnknownSync(Schema.JsonObject)(JSON.parse(plain));

  if (raw["verifier"]) throw new Error("OAuth session is local");
  const value = decode(raw);

  return {
    ...(value.headers && { headers: { ...value.headers } }),
    ...(value.redirectUri && { redirectUri: value.redirectUri }),
    ...(value.expiresAt !== undefined && { expiresAt: value.expiresAt }),
    ...(value.accountIdentity && { accountIdentity: value.accountIdentity }),
    ...(value.tokens && { tokens: OAuthTokensSchema.parse(value.tokens) }),
    ...(value.client && { client: OAuthClientInformationSchema.parse(value.client) }),
    ...(value.discovery && {
      discovery: {
        authorizationServerUrl: value.discovery.authorizationServerUrl,
        ...(value.discovery.resourceMetadataUrl && { resourceMetadataUrl: value.discovery.resourceMetadataUrl }),
        ...(value.discovery.authorizationServerMetadata && {
          authorizationServerMetadata: OAuthMetadataSchema.parse(value.discovery.authorizationServerMetadata),
        }),
        ...(value.discovery.resourceMetadata && {
          resourceMetadata: OAuthProtectedResourceMetadataSchema.parse(value.discovery.resourceMetadata),
        }),
      },
    }),
  };
}
