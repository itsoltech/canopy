import { describe, expect, test } from "bun:test";
import { trustedDesktopRequest } from "../src/lib/server/desktop-origin.ts";
import { connectorOAuthResult } from "../src/lib/server/connector-oauth-result.ts";
import { connectorOAuthBinding } from "../src/lib/server/connector-oauth.ts";

const origin = "http://127.0.0.1:19111";
const callback = "/api/connectors/oauth/callback";

function allowed(path = callback, method = "GET", extra: Record<string, string> = {}) {
  const url = new URL(path, origin);

  const request = new Request(url, {
    method,
    headers: {
      host: url.host,
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
      ...extra,
    },
  });

  return trustedDesktopRequest(request, url, origin);
}

describe("desktop BFF origin boundary", () => {
  test("allows the exact callback navigation with provider query parameters and Origin", () => {
    expect(allowed(`${callback}?state=pending&code=authorization`, "GET", { origin: "https://provider.example" })).toBe(
      true,
    );
    const url = new URL(callback, origin);
    // Older browsers may omit Fetch Metadata, but must still use the expected Host.
    expect(trustedDesktopRequest(new Request(url, { headers: { host: url.host } }), url, origin)).toBe(true);
  });

  test("blocks cross-site writes, fetches, frames and different paths", () => {
    for (const method of ["POST", "PUT", "DELETE", "HEAD", "OPTIONS"]) expect(allowed(callback, method)).toBe(false);

    for (const mode of ["", "cors", "no-cors", "same-origin"])
      expect(allowed(callback, "GET", { "sec-fetch-mode": mode })).toBe(false);

    for (const destination of ["", "empty", "iframe", "image", "script"])
      expect(allowed(callback, "GET", { "sec-fetch-dest": destination })).toBe(false);

    for (const path of ["/", "/api/connectors", "/settings/connectors", `${callback}/`, `${callback}/__data.json`])
      expect(allowed(path)).toBe(false);
  });

  test("rejects a mismatched or missing Host even for a valid callback navigation", () => {
    for (const host of ["attacker.example:19111", "localhost:19111", "127.0.0.1:19112", ""])
      expect(allowed(callback, "GET", { host })).toBe(false);
  });

  test("keeps ordinary same-origin traffic working and rejects foreign Origins without Fetch Metadata", () => {
    expect(
      allowed("/api/connectors", "POST", { origin, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" }),
    ).toBe(true);
    const url = new URL("/api/connectors", origin);
    expect(
      trustedDesktopRequest(
        new Request(url, { headers: { host: url.host, origin: "https://provider.example" } }),
        url,
        origin,
      ),
    ).toBe(false);
    expect(trustedDesktopRequest(new Request(url), url, undefined)).toBe(true);
  });

  test("desktop binding survives the browser change without accepting caller cookies", () => {
    const previous = process.env["CANOPY_WEB_ORIGIN"];

    try {
      process.env["CANOPY_WEB_ORIGIN"] = origin;
      const binding = connectorOAuthBinding(undefined);
      expect(binding).toMatch(/^[\w-]{32,128}$/);
      expect(connectorOAuthBinding("attacker-cookie")).toBe(binding);
      delete process.env["CANOPY_WEB_ORIGIN"];
      expect(connectorOAuthBinding(undefined)).toBe("");
      expect(connectorOAuthBinding("browser-cookie")).toBe("browser-cookie");
    } finally {
      if (previous === undefined) delete process.env["CANOPY_WEB_ORIGIN"];
      else process.env["CANOPY_WEB_ORIGIN"] = previous;
    }
  });

  test("result documents use fixed copy, strip callback parameters and restrict scripts and embedding", async () => {
    const success = connectorOAuthResult("notion", true);
    expect(await success.text()).toContain("Notion connected");
    const result = connectorOAuthResult("<script>untrusted</script>", true);
    const html = await result.text();
    expect(html).not.toContain("untrusted");
    expect(html).toContain("Account connected");
    expect(html).toContain('history.replaceState(null, "", "/api/connectors/oauth/callback")');
    expect(html).toContain("canopy://connectors");
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.headers.get("referrer-policy")).toBe("no-referrer");
    expect(result.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(result.headers.get("content-security-policy")).toContain("default-src 'none'");
    const failure = await connectorOAuthResult(undefined, false).text();
    expect(failure).toContain("Sign-in could not finish");
    expect(failure).toContain("reconnect the account to try again");
  });
});
