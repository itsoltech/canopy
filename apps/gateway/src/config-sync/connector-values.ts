import { fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { ConnectorToolSchema } from "@canopy/contracts";
import { Predicate, Schema } from "effect";
import { connectorType, connectorUrl } from "../connectors/catalog.ts";
import type { Credentials } from "../connectors/records.ts";
import { digest } from "../connectors/records.ts";
import type { Values } from "./provider-values.ts";
import { UUID } from "./project-values.ts";

export const CONNECTOR_KINDS = new Set(["connector", "oauth_app"]);

// Connection status, error diagnostics and last use describe this gateway, never shared configuration.
export const CONNECTOR_FIELDS = new Set([
  "type",
  "name",
  "url",
  "transport",
  "authKind",
  "projectAccess",
  "noProject",
  "allBots",
  "tools",
  "accountIdentity",
  "credentials",
]);

const projectAccess = Schema.is(
  Schema.Struct({
    allProjects: Schema.Boolean,
    projectIds: Schema.Array(Schema.String.check(Schema.isPattern(UUID))),
  }),
);

/** One field versions the complete access replacement, including the explicit list. */
export function connectorProjectAccess(value: JsonValue | undefined, canonical: (id: string) => string = (id) => id) {
  if (!projectAccess(value)) return { allProjects: false, projectIds: [] };

  return {
    allProjects: value.allProjects,
    projectIds: [
      ...new Set(value.projectIds.map((id) => canonical(id.toLowerCase())).filter((id) => UUID.test(id))),
    ].sort(),
  };
}

/** Provider-supplied account metadata, never the client id, access token or refresh token. */
export function accountIdentity(value: Credentials) {
  if (value.oauthSubject) return value.oauthSubject;

  if (value.accountIdentity) return value.accountIdentity;
  const tokens = value.tokens && Schema.decodeUnknownSync(Schema.JsonObject)(value.tokens);

  if (!tokens) return "";

  const ids = ["workspace_id", "account_id", "user_id", "team_id", "sub"].flatMap((name) => {
    const id = tokens[name];

    return Predicate.isString(id) && id ? [[name, id]] : [];
  });

  return ids.length ? digest(JSON.stringify(ids)) : "";
}

/** Only a versioned issuer/subject identifies independently authorized OAuth accounts. */
export function connectorIdentity(kind: string, values: Values) {
  const type = values["type"];

  if (!Predicate.isString(type) || !connectorType(type)) return "";

  if (kind === "oauth_app") return `oauth_app:${type}`;
  const url = values["url"];
  const account = values["accountIdentity"];
  const name = values["name"];

  if (!Predicate.isString(url)) return "";

  if (values["authKind"] === "oauth")
    return Predicate.isString(account) && /^oauth2:[a-f0-9]{64}(:[a-f0-9]{64})?$/.test(account)
      ? digest(JSON.stringify([type, url, account]))
      : "";

  return values["authKind"] === "headers" && Predicate.isString(name) && name.trim()
    ? digest(JSON.stringify([type, url, `name:${name.trim().normalize("NFC")}`]))
    : "";
}

/** Remote definitions pass the same boundary checks as a local save; tools carry no foreign namespace. */
export function connectorColumns(values: Values) {
  try {
    const type = Schema.decodeUnknownSync(Schema.String)(values["type"]);
    const name = Schema.decodeUnknownSync(Schema.String)(values["name"]);
    const url = connectorUrl(Schema.decodeUnknownSync(Schema.String)(values["url"]));
    const transport = values["transport"];
    const authKind = values["authKind"];
    const definition = connectorType(type);

    // oxlint-disable-next-line no-control-regex -- an account name is one line of visible text
    const controlCharacters = /[\x00-\x1f\x7f]/;

    if (
      !definition ||
      !name.trim() ||
      name.length > 80 ||
      controlCharacters.test(name) ||
      (transport !== "http" && transport !== "sse") ||
      !Predicate.isString(authKind) ||
      !definition.authKinds.includes(authKind)
    )
      return undefined;
    const tools = Schema.decodeUnknownSync(Schema.Array(Schema.MutableJson))(values["tools"] ?? []);

    return {
      type,
      name,
      url,
      transport,
      authKind,
      allBots: values["allBots"] === true,
      tools: tools.map((t) => toJson(ConnectorToolSchema, fromJson(ConnectorToolSchema, t))),
    };
  } catch {
    return undefined;
  }
}
