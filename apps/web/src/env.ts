import { defineEnvVars } from "@sveltejs/kit/env";

/** Server-only configuration of the BFF (docs/ui-api.md). Nothing here reaches the browser. */
export const variables = defineEnvVars({
  GATEWAY_URL: {
    description: "Gateway gRPC endpoint (HTTP/2), e.g. http://127.0.0.1:7443 or https://gateway.internal:7443",
    schema: (value) => {
      const url = value || "http://127.0.0.1:7443";

      if (!/^https?:\/\//.test(url)) throw new Error("GATEWAY_URL must be an http(s) URL");

      return url;
    },
  },
  GATEWAY_SERVICE_TOKEN: {
    description: "Service token shared with the gateway (CANOPY_UI_SERVICE_TOKEN). Required when the server runs",
    // Missing is allowed only so `vite build` (which analyses the server) works without secrets;
    // `init` in hooks.server.ts refuses to start the server without it.
    schema: (value) => {
      if (value !== undefined && value.length < 32)
        throw new Error("GATEWAY_SERVICE_TOKEN must have at least 32 characters");

      return value;
    },
  },
});
