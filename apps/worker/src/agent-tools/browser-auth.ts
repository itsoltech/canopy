import type { JsonValue } from "@canopy/domain";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { browserBasicAuth } from "../agent-tools-mcp/browser-policy.ts";
import type { BrowserCdp } from "./browser-cdp.ts";

export const browserAuthTool: Tool = {
  name: browserBasicAuth,
  description:
    'Open an HTTP or HTTPS URL that requires Basic Auth. Use request_secret to ask for a private thread secret. Name the destination in the request and ask the user to enter JSON in the form {"username":"…","password":"…"}. Pass its request_id as requestId. The browser supplies credentials only to a Basic Auth challenge from the URL’s origin.',
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The protected URL, without credentials in the URL." },
      requestId: { type: "string", description: "The request_id of the saved private thread secret." },
    },
    required: ["url", "requestId"],
    additionalProperties: false,
  },
};

const credentials = z.object({
  username: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => !value.includes(":")),
  password: z.string().max(8192),
});

const requestPaused = z.object({ requestId: z.string() });

const authRequired = requestPaused.extend({
  authChallenge: z.object({ source: z.string().optional(), scheme: z.string(), origin: z.string() }),
});

export class BrowserAuth {
  readonly #credential: z.infer<typeof credentials>;
  #submitted = false;
  rejected = false;

  constructor(
    private readonly cdp: BrowserCdp,
    private readonly origin: string,
    secret: string,
  ) {
    try {
      this.#credential = credentials.parse(JSON.parse(secret));
    } catch {
      throw new Error("The private Basic Auth secret must be JSON with username and password fields.");
    }
  }

  async enable(): Promise<void> {
    await this.cdp.send("Fetch.enable", {
      patterns: [{ urlPattern: `${this.origin}/*`, resourceType: "Document" }],
      handleAuthRequests: true,
    });
  }

  async event(method: string, params: JsonValue): Promise<void> {
    if (method === "Fetch.requestPaused") {
      const { requestId } = requestPaused.parse(params);
      await this.cdp.send("Fetch.continueRequest", { requestId });
    }

    if (method !== "Fetch.authRequired") return;
    const { requestId, authChallenge } = authRequired.parse(params);

    const matches =
      authChallenge.source === "Server" &&
      authChallenge.scheme.toLowerCase() === "basic" &&
      authChallenge.origin === this.origin;

    const provide = matches && !this.#submitted;

    if (matches && this.#submitted) this.rejected = true;

    if (provide) this.#submitted = true;
    await this.cdp.send("Fetch.continueWithAuth", {
      requestId,
      authChallengeResponse: provide
        ? { response: "ProvideCredentials", ...this.#credential }
        : { response: "CancelAuth" },
    });
  }
}
