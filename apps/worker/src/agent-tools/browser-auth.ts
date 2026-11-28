import type { JsonValue } from "@canopy/domain";
import { z } from "zod";
import type { BrowserCdp } from "./browser-cdp.ts";

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
