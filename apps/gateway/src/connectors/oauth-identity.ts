import { isJsonObject, type JsonObject, type JsonValue } from "@canopy/domain";
import { Predicate } from "effect";
import { digest, type Credentials } from "./records.ts";

const id = (value: JsonValue | undefined) => (Predicate.isString(value) && value.trim() ? value : undefined);
const nestedId = (value: JsonValue | undefined) => (isJsonObject(value) ? id(value["id"]) : undefined);

/** The token endpoint identifies the principal. Workspace and application identifiers alone are ambiguous. */
export function recordOAuthIdentity(type: string, value: Credentials, metadata: JsonObject, issuer: string) {
  const owner = metadata["owner"];
  const ownerId = isJsonObject(owner) ? nestedId(owner["user"]) : undefined;

  const ids = ["workspace_id", "account_id", "user_id", "team_id", "sub"].flatMap((key) => {
    const tokenId = id(metadata[key]);

    return tokenId ? [[key, tokenId]] : [];
  });

  if (ownerId) ids.push(["owner", ownerId]);

  // Retain the existing reconnect check for credentials issued before principal binding.
  if (ids.length) value.accountIdentity = digest(JSON.stringify(ids));
  const team = nestedId(metadata["team"]) ?? id(metadata["team_id"]);

  if (team) value.slackTeamId = team;

  const subjects =
    type === "slack"
      ? [["user", nestedId(metadata["authed_user"]) ?? id(metadata["user_id"])]]
      : [
          ["sub", id(metadata["sub"])],
          ["user", id(metadata["user_id"])],
          ["owner", ownerId],
        ];

  const subject = subjects.find(([, subjectId]) => subjectId);

  if (!subject) return;
  const principal = `oauth2:${digest(JSON.stringify([new URL(issuer).href, type, subject]))}`;
  const tenant = type === "slack" ? team : (id(metadata["workspace_id"]) ?? team ?? id(metadata["account_id"]));
  const identity = tenant ? `${principal}:${digest(tenant)}` : principal;

  if (value.oauthSubject && value.oauthSubject !== identity && value.oauthSubject !== principal) {
    // Some providers omit the tenant on refresh. The same issuer/subject keeps its already proven scope.
    if (!tenant && value.oauthSubject.startsWith(`${principal}:`)) return;
    throw new Error("OAuth principal changed during refresh");
  }

  if (type !== "slack" || team) value.oauthSubject = identity;
}
