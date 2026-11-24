import { create } from "@bufbuild/protobuf";
import { connectors } from "@canopy/contracts";
import { DEFAULT_OAUTH_REDIRECT_URL } from "@canopy/domain/oauth-return";
import { AUTH_METHODS } from "./auth-methods.ts";
import { slackAppManifest } from "./slack-app.ts";

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
    name: "Slack User",
    url: "https://mcp.slack.com/mcp",
    authKinds: ["oauth"],
    requirements: "Lets agents read and send messages as you through Slack's MCP server. Requires a Slack app.",
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
    documentationUrl:
      "https://support.atlassian.com/atlassian-ai-gateway/docs/get-started-with-the-atlassian-remote-mcp-server/",
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

/** User-entered remote endpoints and callback URLs. */
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
