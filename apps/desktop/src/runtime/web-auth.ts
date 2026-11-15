import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { DESKTOP_SESSION_HEADER } from "../web-session.ts";

/** Guard before adapter-node, including its static assets, setup page, API and SSE. */
export function desktopWebListener(
  origin: string,
  token: string,
  handle: (request: IncomingMessage, response: ServerResponse) => void,
) {
  if (!token) throw new Error("The desktop web session is missing");
  const expected = Buffer.from(token);
  const host = new URL(origin).host;

  return (request: IncomingMessage, response: ServerResponse) => {
    const headers = request.headers;
    const supplied = headers[DESKTOP_SESSION_HEADER];
    const provided = Buffer.from(Array.isArray(supplied) ? "" : (supplied ?? ""));
    const authenticated = provided.length === expected.length && timingSafeEqual(provided, expected);

    // The system browser has a separate session. Only this exact document return may reach the BFF;
    // its gateway still requires the pending, single-use state and this BFF's private OAuth binding.
    const callback =
      request.method === "GET" &&
      request.url?.split("?")[0] === "/api/connectors/oauth/callback" &&
      (!headers["sec-fetch-mode"] || headers["sec-fetch-mode"] === "navigate") &&
      (!headers["sec-fetch-dest"] || headers["sec-fetch-dest"] === "document");

    const sameOrigin = (!headers.origin || headers.origin === origin) && headers["sec-fetch-site"] !== "cross-site";

    delete headers[DESKTOP_SESSION_HEADER];

    if (headers.host !== host || (!callback && (!authenticated || !sameOrigin))) {
      response.writeHead(403, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        connection: "close",
      });
      response.end("Open Canopy to use this app.\n");

      return;
    }

    handle(request, response);
  };
}
