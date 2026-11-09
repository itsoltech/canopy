import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { fileResponse } from "../../apps/web/src/lib/server/files.ts";

test("private immutable representations have SHA256 validators and conditional responses", async () => {
  const data = new TextEncoder().encode("immutable attachment");
  const response = fileResponse(data, "image/png");
  const etag = `"${createHash("sha256").update(data).digest("hex")}"`;
  expect(response.headers.get("etag")).toBe(etag);
  expect(response.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
  expect(response.headers.get("vary")).toBe("Cookie, Authorization");
  expect(fileResponse(data.subarray(0, 4), "image/webp").headers.get("etag")).not.toBe(etag);
  const fresh = fileResponse(data, "image/png", { ifNoneMatch: `"other", W/${etag}` });
  expect(fresh.status).toBe(304);
  expect(await fresh.text()).toBe("");
  expect(fileResponse(data, "image/png", { ifNoneMatch: '"other"' }).status).toBe(200);
});
