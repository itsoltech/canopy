import type { MessageInitShape } from "@bufbuild/protobuf";
import { connectors } from "@canopy/contracts";
import { SLACK_USER_SCOPES } from "./slack-app.ts";

type AuthMethod = MessageInitShape<typeof connectors.ConnectorAuthMethodSchema>;

const bearer = "Sent as a bearer token. Stored encrypted in the gateway.";

/** Discovery and dynamic registration on the server; a registered app stays an advanced option. */
const signIn = (service: string, steps: string[]): AuthMethod => ({
  authKind: "oauth",
  label: `Sign in with ${service}`,
  description: `Approve access in ${service}. No app to register.`,
  steps,
  scopeDescription: "Leave empty to use the scopes the server asks for.",
  scopePlaceholder: "Server defaults",
});

/** Per connector type, in the order of its `authKinds`. Checked against the type's documentation, 2026-11-04. */
export const AUTH_METHODS = {
  github: [
    {
      authKind: "headers",
      label: "Personal access token",
      description: "A fine-grained token from your GitHub settings.",
      steps: [
        "Create a fine-grained personal access token in GitHub.",
        "Choose the repositories and permissions agents may use.",
        "Paste the token below.",
      ],
      setupUrl: "https://github.com/settings/personal-access-tokens/new",
      setupLabel: "Create a token on GitHub",
      tokenLabel: "Personal access token",
      tokenDescription: bearer,
      tokenRequired: true,
    },
    {
      authKind: "oauth",
      label: "GitHub OAuth app",
      description: "Sign in through an OAuth app you register in GitHub.",
      steps: [
        "Register an OAuth app in GitHub with the callback URL below.",
        "Save its client ID and secret here.",
        "Continue to sign in with GitHub.",
      ],
      setupUrl: "https://github.com/settings/applications/new",
      setupLabel: "Register an OAuth app on GitHub",
      oauthAppRequired: true,
      scopeDescription: "Space-separated GitHub scopes. Leave empty to use the scopes the server asks for.",
      scopePlaceholder: "repo read:org",
    },
  ],
  slack: [
    {
      authKind: "oauth",
      label: "Slack app",
      description: "Sign in through a Slack app in your workspace. Slack has no automatic registration.",
      steps: [
        "Create the Slack app, or use an existing one from your workspace.",
        "Save its client ID and secret here, then continue to sign in.",
      ],
      oauthAppRequired: true,
      scopeDescription: "Space-separated user scopes of your Slack app.",
      scopePlaceholder: "search:read.public users:read",
      defaultScope: SLACK_USER_SCOPES.join(" "),
    },
  ],
  notion: [
    signIn("Notion", ["Continue to sign in with Notion.", "Choose the workspace agents may use and approve access."]),
    {
      authKind: "headers",
      label: "MCP access token",
      description: "For Notion Business and Enterprise plans.",
      steps: ["Create an MCP access token in Notion.", "Paste it below. Internal integration tokens do not work here."],
      tokenLabel: "MCP access token",
      tokenDescription: bearer,
      tokenRequired: true,
    },
  ],
  linear: [
    signIn("Linear", ["Continue to sign in with Linear.", "Choose the workspace and approve access."]),
    {
      authKind: "headers",
      label: "API key",
      description: "A personal API key from your Linear settings.",
      steps: ["Create a personal API key in Linear settings under Security & access.", "Paste the key below."],
      tokenLabel: "API key",
      tokenDescription: bearer,
      tokenRequired: true,
    },
  ],
  atlassian: [
    signIn("Atlassian", [
      "Continue to sign in with your Atlassian account.",
      "Choose the Jira or Confluence site and approve access. Your administrator may restrict MCP clients.",
    ]),
  ],
  microsoft: [
    {
      ...signIn("Microsoft", [
        "Ask your administrator for the MCP endpoint approved for your tenant.",
        "Enter it below and continue to sign in with your work account.",
      ]),
      description: "Your work account, through your tenant's MCP endpoint.",
    },
    {
      authKind: "headers",
      label: "Access token",
      description: "A token issued by your tenant.",
      steps: ["Enter your tenant's MCP endpoint.", "Paste the access token your administrator provided."],
      tokenLabel: "Access token",
      tokenDescription: bearer,
    },
  ],
  google: [
    {
      ...signIn("Google", [
        "Enter your own remote MCP server. No official Gmail or Calendar endpoint is verified yet.",
        "Continue to sign in with Google.",
      ]),
      description: "Your Google account, through your own MCP server.",
    },
    {
      authKind: "headers",
      label: "Access token",
      description: "A token for your own MCP server.",
      steps: ["Enter your remote MCP server.", "Paste the token it expects, or leave it empty."],
      tokenLabel: "Access token",
      tokenDescription: bearer,
    },
  ],
  custom: [
    {
      authKind: "headers",
      label: "Token or headers",
      description: "A bearer token, other headers, or none.",
      steps: ["Enter the server's Streamable HTTP or SSE endpoint.", "Add the token or headers it expects."],
      tokenLabel: "Bearer token",
      tokenDescription: bearer,
    },
    {
      ...signIn("OAuth", [
        "Enter the server's endpoint.",
        "Continue to sign in. Canopy discovers the server's OAuth settings.",
        "If the server needs a registered app, add it under Advanced first.",
      ]),
      description: "For servers that support OAuth discovery.",
    },
  ],
} satisfies Record<string, AuthMethod[]>;
