import { expect, test } from "bun:test";
import { antigravityGeminiKey } from "./gemini-key.ts";

test("a process key forwards Gemini generation only to the configured server and expires on close", async () => {
  const upstreamKey = "private-test-value";
  const calls: { url: string; key: string | null; cookie: string | null }[] = [];

  const upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      calls.push({
        url: request.url,
        key: request.headers.get("x-goog-api-key"),
        cookie: request.headers.get("cookie"),
      });

      return calls.length === 1
        ? new Response("upstream reply", { headers: { "set-cookie": "private=yes" } })
        : Response.redirect(new URL("/another-service", request.url).href, 307);
    },
  });

  const route = antigravityGeminiKey(upstreamKey, upstream.url.origin + "/gemini");
  const base = route.env.GOOGLE_GEMINI_BASE_URL;
  const path = "/v1beta/models/gemini-3.1-pro:streamGenerateContent";
  const headers = { "x-goog-api-key": route.env.GEMINI_API_KEY, cookie: "account=yes" };

  try {
    expect(route.env.GEMINI_API_KEY).not.toBe(upstreamKey);
    expect((await fetch(base + path, { method: "POST" })).status).toBe(401);
    expect((await fetch(base + path, { headers })).status).toBe(404);
    expect((await fetch(base + "/v1beta/files", { method: "POST", headers })).status).toBe(404);
    expect((await fetch(base + path, { method: "POST", headers: { ...headers, host: "other-host" } })).status).toBe(
      403,
    );
    expect(calls).toEqual([]);
    const response = await fetch(base + path + "?alt=sse&key=wrong", { method: "POST", headers, body: "{}" });
    expect(await response.text()).toBe("upstream reply");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(calls).toEqual([
      { url: upstream.url.origin + "/gemini" + path + "?alt=sse", key: upstreamKey, cookie: null },
    ]);
    expect((await fetch(base + path, { method: "POST", headers, body: "{}" })).status).toBe(502);
    expect(calls).toHaveLength(2);
  } finally {
    await route.close();
    await upstream.stop(true);
  }

  await expect(fetch(base + path, { method: "POST", headers })).rejects.toThrow();
});
