import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { browserBasicAuth, browserFillLogin, browserFillOneTimeCode } from "../agent-tools-mcp/browser-policy.ts";

const login = {
  type: "string",
  description: "A login name from list_project_secrets (its logins list).",
};

const element = (what: string) => ({
  type: "string",
  description: `The ${what} field: an element @ref from a snapshot, or a CSS selector.`,
});

const submit = {
  type: "boolean",
  description: "Press Enter in the last field after entering it. Omit to submit the form yourself.",
};

export const fillLoginTool: Tool = {
  name: browserFillLogin,
  description:
    "Sign in with a project login. Canopy enters the username and/or password into the given fields of the current page; you never see the password. It works only on the login's websites (list_project_secrets lists them). Take a snapshot first to find the fields. Values on the page stay masked in tool output.",
  inputSchema: {
    type: "object",
    properties: { login, username: element("username or email"), password: element("password"), submit },
    required: ["login"],
    additionalProperties: false,
  },
};

export const fillOneTimeCodeTool: Tool = {
  name: browserFillOneTimeCode,
  description:
    "Enter the current one-time code (TOTP) of a project login that has one into the given field. Canopy generates the code; it works only on the login's websites.",
  inputSchema: {
    type: "object",
    properties: { login, field: element("one-time code"), submit },
    required: ["login", "field"],
    additionalProperties: false,
  },
};

export const basicAuthTool: Tool = {
  name: browserBasicAuth,
  description:
    'Open an HTTP or HTTPS URL that requires Basic Auth. Pass a project login name as login, or use request_secret to ask for a private thread secret: name the destination and ask the user for JSON in the form {"username":"…","password":"…"}, then pass its request_id as requestId. The browser supplies credentials only to a Basic Auth challenge from the URL’s origin.',
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The protected URL, without credentials in the URL." },
      login: { ...login, description: "A project login for this URL's website. Use instead of requestId." },
      requestId: { type: "string", description: "The request_id of the saved private thread secret." },
    },
    required: ["url"],
    additionalProperties: false,
  },
};
