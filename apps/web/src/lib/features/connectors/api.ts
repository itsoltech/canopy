import { connectors } from "@canopy/contracts";
import { requestJson } from "#lib/shared/http.ts";
import { decode } from "#lib/shared/wire.ts";

export const listConnectors = async (scope = "") => decode(connectors.ListConnectorsResponseSchema, await requestJson("GET", `/api/connectors${scope}`));
export const connectorLabel = (account: connectors.ConnectorAccount, types: readonly connectors.ConnectorType[]) => `${types.find((t) => t.id === account.connectorType)?.name ?? account.connectorType} · ${account.name}`;
export const accountStatus = (status: string) => ({ connected: "Connected", needs_reconnect: "Needs reconnect", error: "Connection error", disconnected: "Disconnected" })[status] ?? status;
