import type { connectors, github } from "@canopy/contracts";
import { marketplaceReference, parseSourceCommand } from "./source-command.ts";

export type SourceKind = "skill" | "marketplace";

export function matchesSourceOrigin(origin: string, connectorType: string, accountUrl: string): boolean {
  if (connectorType === "github_repository") return false;

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

/** Native source references use GitHub's stable user ID so each home resolves its own login. */
export function gitHubSourceId(user: string, repository = "") {
  return repository ? `github:${user}:${repository}` : `github:${user}`;
}

export function sourceGitHubAccount(id: string) {
  const parts = /^github:([1-9][0-9]{0,15})(?::([1-9][0-9]{0,15}))?$/.exec(id);

  return parts && { user: parts[1]!, repository: parts[2] ?? "" };
}

export function sourceGitHubRepository(url: string) {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})\.git$/.exec(url);

  if (!match || [match[1], match[2]].some((part) => part === "." || part === "..")) return undefined;

  return `${match[1]}/${match[2]}`;
}

export function sourceUrl(command: string, kind: SourceKind) {
  try {
    return (kind === "marketplace" ? marketplaceReference(command) : parseSourceCommand(command).source).url;
  } catch {
    return "";
  }
}

export function eligibleSourceAccounts(
  command: string,
  kind: SourceKind,
  accounts: readonly connectors.ConnectorAccount[],
  gitHubAccounts: readonly github.GitHubAccount[] = [],
) {
  const url = sourceUrl(command, kind);

  if (!url) return [];
  const origin = new URL(url).origin;

  const native = sourceGitHubRepository(url)
    ? gitHubAccounts.flatMap((account) =>
        account.status === "connected" && account.host === "github.com"
          ? [{ id: gitHubSourceId(account.githubUserId), label: `@${account.login} · GitHub` }]
          : [],
      )
    : [];

  const connectors = accounts.flatMap((account) =>
    account.status === "connected" &&
    (account.authKind === "oauth" || account.headerNames.some((name) => name.toLowerCase() === "authorization")) &&
    matchesSourceOrigin(origin, account.connectorType, account.url)
      ? [{ id: account.id, label: `${account.name} · ${new URL(account.url).host}` }]
      : [],
  );

  return [...native, ...connectors];
}
