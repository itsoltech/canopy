import { create } from "@bufbuild/protobuf";
import { connectors } from "@open-agents/contracts";

/** Endpoints checked against vendor documentation, 2026-11-02; never imply a live account check. */
export const CONNECTOR_TYPES = [
  { id: "github", name: "GitHub", url: "https://api.githubcopilot.com/mcp/", authKinds: ["headers", "oauth"], requirements: "Personal access token, or a registered GitHub OAuth app. Live authorization required.", documentationUrl: "https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md" },
  { id: "slack", name: "Slack", url: "https://mcp.slack.com/mcp", authKinds: ["oauth"], requirements: "Register a Slack app first. Save its client ID and secret, install it, and choose user scopes.", documentationUrl: "https://docs.slack.dev/ai/slack-mcp-server/" },
  { id: "notion", name: "Notion", url: "https://mcp.notion.com/mcp", authKinds: ["oauth", "headers"], requirements: "Sign in with OAuth. MCP tokens are available on Business / Enterprise; integration tokens are different.", documentationUrl: "https://developers.notion.com/guides/mcp/get-started-with-mcp" },
  { id: "linear", name: "Linear", url: "https://mcp.linear.app/mcp", authKinds: ["oauth", "headers"], requirements: "Sign in with OAuth, or use a Linear API key.", documentationUrl: "https://linear.app/docs/mcp" },
  { id: "atlassian", name: "Atlassian", url: "https://mcp.atlassian.com/v1/mcp", authKinds: ["oauth"], requirements: "Sign in to Jira / Confluence. Your administrator may restrict MCP clients.", documentationUrl: "https://support.atlassian.com/atlassian-rovo-mcp-server/" },
  { id: "microsoft", name: "Microsoft 365 · Outlook", url: "", authKinds: ["oauth", "headers"], requirements: "Use the MCP endpoint approved for your tenant (Work IQ / Tools registry). Requires tenant configuration and live verification.", documentationUrl: "https://learn.microsoft.com/en-us/microsoft-agent-365/tooling-servers-overview" },
  { id: "google", name: "Google Workspace", url: "", authKinds: ["oauth", "headers"], requirements: "Provide your remote MCP server. A general official Gmail / Calendar remote endpoint has not been verified.", documentationUrl: "https://developers.google.com/workspace" },
  { id: "custom", name: "Custom MCP server", url: "", authKinds: ["headers", "oauth"], requirements: "Remote Streamable HTTP or SSE. Use OAuth discovery, a bearer token, or secret headers.", documentationUrl: "https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization" },
].map((t) => create(connectors.ConnectorTypeSchema, t));

export function connectorType(id: string) { return CONNECTOR_TYPES.find((t) => t.id === id); }

/** User-entered remote endpoints, also applied to every OAuth discovery request. */
export function connectorUrl(raw: string): string {
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash || !(url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
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
  return fetch(input, { ...init, redirect: "error", signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) });
};
