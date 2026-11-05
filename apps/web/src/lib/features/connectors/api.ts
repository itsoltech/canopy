import { connectors } from "@canopy/contracts";
import { requestJson } from "#lib/shared/http.ts";
import { decode } from "#lib/shared/wire.ts";

export const listConnectors = async (scope = "") =>
  decode(connectors.ListConnectorsResponseSchema, await requestJson("GET", `/api/connectors${scope}`));

export const connectorLabel = (account: connectors.ConnectorAccount, types: readonly connectors.ConnectorType[]) =>
  `${types.find((t) => t.id === account.connectorType)?.name ?? account.connectorType} · ${account.name}`;

export const accountStatus = (status: string) =>
  ({
    connected: "Connected",
    needs_reconnect: "Needs reconnect",
    error: "Connection error · Tools unavailable",
    disconnected: "Disconnected",
  })[status] ?? status;

/** Finishes a sign-in that came back without the callback: a pasted code, or the desktop app's return. */
export const completeConnectorOAuth = async (
  body: { pastedCode: string } | { state: string; code: string; error: string; issuer: string },
) =>
  decode(
    connectors.CompleteConnectorOAuthResponseSchema,
    await requestJson("POST", "/api/connectors/oauth/code", body, 65000),
  );
