import { create } from "@bufbuild/protobuf";
import { connectors } from "@canopy/contracts";
import { safeFailureDetail } from "@canopy/domain";
import { McpFailure } from "../bots/mcp-errors.ts";
import { connectorType } from "./catalog.ts";
import { redactConnector } from "./oauth.ts";
import type { Credentials } from "./records.ts";
import { ConnectorFailure } from "./records.ts";

/** A completed test with a negative result, distinct from an invalid request or store failure. */
export class ConnectorTestFailure extends ConnectorFailure {
  constructor(
    readonly account: connectors.ConnectorAccount,
    message: string,
  ) {
    super(message);
  }
}

function explanation(error: McpFailure, service: string, slack: boolean): string {
  if (error.phase === "oauth/token") {
    if (error.kind === "network")
      return "Could not reach the sign-in provider. Check the connection, then start sign-in again.";

    if (error.kind === "timeout") return "The sign-in provider took too long to respond. Start sign-in again.";

    return `${service} rejected sign-in. Check the app settings, then start sign-in again.`;
  }

  if (error.status === 401) return `${service} rejected the token (401). Reconnect the account.`;

  if (slack && /app is not enabled for slack mcp server access/i.test(error.serverMessage))
    return "Slack MCP access is off for this app. Turn it on in the app's settings, then test again.";

  if (error.status === 403)
    return slack
      ? "Slack denied access to this app (403). Check the app's installation, approval and distribution settings."
      : `${service} denied access (403). Check the account's permissions, then reconnect.`;

  if (error.status === 404) return "The server endpoint was not found (404). Check the endpoint, then reconnect.";

  if (error.status === 429) return "The server received too many requests (429). Wait, then test again.";

  if (error.status >= 500) return `The server is unavailable (${error.status}). Test again later.`;

  if (error.kind === "oauth") return `${service} could not authorize the account. Reconnect the account.`;

  if (error.kind === "network") return "Couldn't reach the server. Check your connection, then test again.";

  if (error.kind === "timeout") return "The server took too long to respond. Test again.";

  if (error.kind === "protocol") return "The server sent an unexpected response. Check the endpoint, then test again.";

  return `The server rejected the request (${error.status}). Check the endpoint and account permissions, then test again.`;
}

/** Only this redacted projection may leave the gateway credential boundary. */
export function connectorTestError(
  cause: unknown,
  type: string,
  value: Credentials,
  secrets: readonly string[] = [],
): connectors.ConnectorError {
  const error = cause instanceof McpFailure ? cause : new McpFailure("protocol", "tools/list", 0, "test_failed");

  const safe = (text: string) =>
    safeFailureDetail(redactConnector(text, value, secrets))
      // One warning line, even if a server tries to inject log lines or terminal escapes.
      // oxlint-disable-next-line no-control-regex -- diagnostic text must not contain terminal control characters
      .replace(/[\x00-\x1f\x7f]/g, " ")
      .slice(0, 2000);

  const detail = [
    `Phase: ${error.phase}`,
    `Class: ${error.kind}`,
    error.status && `HTTP status: ${error.status}`,
    error.serverCode && `Code: ${safe(error.serverCode)}`,
    error.serverMessage && `Message: ${safe(error.serverMessage)}`,
  ]
    .filter(Boolean)
    .join("; ");

  return create(connectors.ConnectorErrorSchema, {
    kind: error.kind,
    message: explanation(error, connectorType(type)?.name ?? "The server", type === "slack"),
    detail,
  });
}
