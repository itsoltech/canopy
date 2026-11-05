import { create } from "@bufbuild/protobuf";
import { connectors } from "@canopy/contracts";
import { AUTH_METHODS } from "./auth-methods.ts";
import { slackAppManifest } from "./slack-app.ts";

/** The redirect page on the repository's GitHub Pages site; it returns each sign-in to its own Canopy. */
export const DEFAULT_OAUTH_REDIRECT_URL = "https://itsoltech.github.io/canopy/oauth/callback";

/** Endpoints checked against vendor documentation, 2026-11-02; never imply a live account check. */
export const CONNECTOR_TYPES = [
  {
    id: "github",
    name: "GitHub",
    url: "https://api.githubcopilot.com/mcp/",
    authKinds: ["headers", "oauth"],
    requirements: "Repositories, issues and pull requests through GitHub's remote MCP server.",
    documentationUrl: "https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md",
    authMethods: AUTH_METHODS.github,
  },
  {
    id: "slack",
    name: "Slack",
    url: "https://mcp.slack.com/mcp",
    authKinds: ["oauth"],
    requirements: "Messages and channels through Slack's MCP server. Needs a Slack app.",
    documentationUrl: "https://docs.slack.dev/ai/slack-mcp-server/",
    authMethods: AUTH_METHODS.slack,
  },
  {
    id: "notion",
    name: "Notion",
    url: "https://mcp.notion.com/mcp",
    authKinds: ["oauth", "headers"],
    requirements: "Pages and databases through Notion's MCP server.",
    documentationUrl: "https://developers.notion.com/guides/mcp/get-started-with-mcp",
    authMethods: AUTH_METHODS.notion,
  },
  {
    id: "linear",
    name: "Linear",
    url: "https://mcp.linear.app/mcp",
    authKinds: ["oauth", "headers"],
    requirements: "Issues and projects through Linear's MCP server.",
    documentationUrl: "https://linear.app/docs/mcp",
    authMethods: AUTH_METHODS.linear,
  },
  {
    id: "atlassian",
    name: "Atlassian",
    url: "https://mcp.atlassian.com/v1/mcp",
    authKinds: ["oauth"],
    requirements: "Jira and Confluence through the Atlassian Rovo MCP server.",
    documentationUrl: "https://support.atlassian.com/atlassian-rovo-mcp-server/",
    authMethods: AUTH_METHODS.atlassian,
  },
  {
    id: "microsoft",
    name: "Microsoft 365 · Outlook",
    url: "",
    authKinds: ["oauth", "headers"],
    requirements: "Outlook and Microsoft 365 through your tenant's MCP endpoint.",
    documentationUrl: "https://learn.microsoft.com/en-us/microsoft-agent-365/tooling-servers-overview",
    authMethods: AUTH_METHODS.microsoft,
  },
  {
    id: "google",
    name: "Google Workspace",
    url: "",
    authKinds: ["oauth", "headers"],
    requirements: "Gmail and Calendar through your own remote MCP server.",
    documentationUrl: "https://developers.google.com/workspace",
    authMethods: AUTH_METHODS.google,
  },
  {
    id: "custom",
    name: "Custom MCP server",
    url: "",
    authKinds: ["headers", "oauth"],
    requirements: "Any remote MCP server over Streamable HTTP or SSE.",
    documentationUrl: "https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization",
    authMethods: AUTH_METHODS.custom,
  },
].map((t) => create(connectors.ConnectorTypeSchema, t));

/** S256 OAuth registrations use this redirect. An installation may set its own callback to skip the page. */
export function oauthRedirectUrl(): string {
  return connectorUrl(process.env["CANOPY_OAUTH_REDIRECT_URL"] || DEFAULT_OAUTH_REDIRECT_URL);
}

/** The catalog for one owner: registered-app methods carry the redirect URL and, for Slack, the app manifest. */
export function connectorCatalog(apps: readonly string[]) {
  const redirectUrl = oauthRedirectUrl();
  const slack = slackAppManifest(redirectUrl);

  return CONNECTOR_TYPES.map((t) =>
    create(connectors.ConnectorTypeSchema, {
      ...t,
      oauthAppSet: apps.includes(t.id),
      authMethods: t.authMethods.map((m) =>
        m.oauthAppRequired
          ? create(connectors.ConnectorAuthMethodSchema, {
              ...m,
              redirectUrl,
              ...(t.id === "slack" && { appManifest: slack.manifest, appCreateUrl: slack.createUrl }),
            })
          : m,
      ),
    }),
  );
}

export function connectorType(id: string) {
  return CONNECTOR_TYPES.find((t) => t.id === id);
}

/** User-entered remote endpoints, also applied to every OAuth discovery request. */
export function connectorUrl(raw: string): string {
  const url = new URL(raw);

  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
  ) {
    throw new Error("Use HTTPS (HTTP only on loopback), without credentials, query or fragment");
  }

  return url.toString();
}

export const oauthFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = input instanceof Request ? input.url : String(input);
  // OAuth requests legitimately have query strings; credentials in URLs are never allowed.
  const parsed = new URL(url);
  connectorUrl(`${parsed.origin}${parsed.pathname}`);

  if (parsed.username || parsed.password) throw new Error("Invalid OAuth endpoint");

  return fetch(input, {
    ...init,
    redirect: "error",
    signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
  });
};
