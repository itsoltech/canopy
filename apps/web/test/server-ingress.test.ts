import { expect, test } from "bun:test";
import { isString } from "@canopy/domain/json";
import { request, type IncomingHttpHeaders } from "node:http";
import { startStandaloneWeb } from "../scripts/standalone.ts";
import { trustedDevRequest } from "../src/lib/server/dev-origin.ts";

function read(port: number, host: string, forwarded = "") {
  return new Promise<{ status: number | undefined; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, headers: { host, "x-forwarded-host": forwarded } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });

    req.on("error", reject);
    req.end();
  });
}

test("standalone web binds loopback and validates raw Host before the adapter uses its public origin", async () => {
  let calls = 0;

  const { server } = await startStandaloneWeb(
    async () => ({
      handler(req, res) {
        calls++;
        res.end(`${req.headers["x-forwarded-proto"]}://${req.headers["x-forwarded-host"]}`);
      },
    }),
    { PORT: "0", ORIGIN: "https://panel.example:8443" },
  );

  try {
    const address = server.address();

    if (!address || isString(address)) throw new Error("Expected an IPv4 listener");
    expect(address.address).toBe("127.0.0.1");
    expect((await read(address.port, "preview.example", "panel.example:8443")).status).toBe(421);
    expect(calls).toBe(0);

    const allowed = await read(address.port, "panel.example:8443");
    expect(allowed.status).toBe(200);
    expect(allowed.body).toBe("https://panel.example:8443");
    expect(allowed.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(allowed.headers["x-frame-options"]).toBe("DENY");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((cause) => (cause ? reject(cause) : resolve())));
  }
});

test("dev accepts its own forms and API clients while isolating other loopback origins", () => {
  const url = new URL("http://localhost:5173/threads/new");
  const form = { "content-type": "application/x-www-form-urlencoded" };
  const other = "http://localhost:9000";

  const allowed = (method: string, headers: Record<string, string>) =>
    trustedDevRequest(new Request(url, { method, headers }), url);

  expect(allowed("GET", {})).toBe(true);
  expect(allowed("GET", { origin: other })).toBe(false);
  expect(allowed("POST", { ...form, origin: url.origin })).toBe(true);
  expect(allowed("POST", { ...form, origin: other })).toBe(false);
  expect(allowed("POST", { ...form, "sec-fetch-site": "same-site" })).toBe(false);
  expect(allowed("POST", { ...form, origin: "null" })).toBe(false);
  expect(allowed("POST", { "content-type": "application/json" })).toBe(true);
  const callback = new URL("/api/connectors/oauth/callback", url);
  expect(
    trustedDevRequest(
      new Request(callback, {
        headers: { origin: "https://provider.example", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
      }),
      callback,
    ),
  ).toBe(true);
});
