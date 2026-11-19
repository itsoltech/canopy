import type { connectors } from "@canopy/contracts";
import { marketplaceReference, parseSourceCommand } from "./source-command.ts";

export type SourceKind = "skill" | "marketplace";

export function matchesSourceOrigin(origin: string, connectorType: string, accountUrl: string): boolean {
  if (
    origin === "https://github.com" &&
    connectorType === "github" &&
    accountUrl === "https://api.githubcopilot.com/mcp/"
  )
    return true;

  try {
    return new URL(accountUrl).origin === origin;
  } catch {
    return false;
  }
}

export function eligibleSourceAccounts(
  command: string,
  kind: SourceKind,
  accounts: readonly connectors.ConnectorAccount[],
): connectors.ConnectorAccount[] {
  if (!accounts.length) return [];
  let origin: string;

  try {
    const source = kind === "marketplace" ? marketplaceReference(command) : parseSourceCommand(command).source;
    origin = new URL(source.url).origin;
  } catch {
    return [];
  }

  return accounts.filter(
    (account) =>
      account.status === "connected" &&
      (account.authKind === "oauth" || account.headerNames.some((name) => name.toLowerCase() === "authorization")) &&
      matchesSourceOrigin(origin, account.connectorType, account.url),
  );
}
