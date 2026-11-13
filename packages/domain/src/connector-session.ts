import type { ConnectorTool } from "@canopy/contracts";
import { createHash } from "node:crypto";
import { Schema } from "effect";

export const ConnectorSessionAccount = Schema.Struct({
  accountId: Schema.String,
  accountName: Schema.String,
  connectorType: Schema.String,
  signature: Schema.String,
});

export const ConnectorSessionCatalog = Schema.Array(ConnectorSessionAccount);

export type ConnectorSessionCatalog = typeof ConnectorSessionCatalog.Type;

/** Credential-free identity of the tools actually offered to one provider turn. */
export function connectorSessionCatalog(tools: readonly ConnectorTool[]): ConnectorSessionCatalog {
  const accounts = new Map<string, ConnectorTool[]>();

  for (const tool of tools) accounts.set(tool.accountId, [...(accounts.get(tool.accountId) ?? []), tool]);

  return [...accounts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([accountId, tools]) => ({
      accountId,
      accountName: tools[0]!.accountName,
      connectorType: tools[0]!.connectorType,
      signature: createHash("sha256")
        .update(
          JSON.stringify(
            tools
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((t) => [t.name, t.remoteName, t.description, t.inputSchemaJson, t.readOnly]),
          ),
        )
        .digest("hex"),
    }));
}

export function connectorSessionNote(previous: ConnectorSessionCatalog, next: ConnectorSessionCatalog): string {
  const label = (account: typeof ConnectorSessionAccount.Type) =>
    `${account.connectorType === "custom" ? "Custom MCP server" : account.connectorType} · ${JSON.stringify(account.accountName)}`;

  const lines = next.flatMap((account) => {
    const before = previous.find((a) => a.accountId === account.accountId);

    if (before?.signature === account.signature && before.accountName === account.accountName) return [];

    return [`[canopy] Connector ${label(account)} ${before ? "tools have changed" : "is now available"}.`];
  });

  for (const account of previous)
    if (!next.some((a) => a.accountId === account.accountId))
      lines.push(`[canopy] Connector ${label(account)} is no longer available.`);

  return lines.join("\n");
}
