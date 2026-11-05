import { expect, test } from "bun:test";
import { desktopLink } from "../src/desktop-link.ts";

test("connector returns accept only the fixed app link without caller-controlled data", () => {
  expect(desktopLink("canopy://connectors", "canopy")).toEqual({ connectors: true });

  for (const link of [
    "https://connectors",
    "canopy://connectors/other",
    "canopy://connectors?state=untrusted",
    "canopy://connectors#untrusted",
    "canopy://user:secret@connectors",
    "canopy://connectors:1234",
  ])
    expect(desktopLink(link, "canopy")).toBeUndefined();
});

test("enrollment links still validate origins, token bounds and fingerprint", () => {
  const url = new URL("canopy://enroll");
  url.searchParams.set("gateway", "https://gateway.example");
  url.searchParams.set("web", "https://web.example");
  url.searchParams.set("token", "fixture-enrollment-token");
  expect(desktopLink(url.href, "canopy")).toEqual({
    enrollment: {
      gatewayUrl: "https://gateway.example",
      webUrl: "https://web.example",
      enrollmentToken: "fixture-enrollment-token",
      gatewayFingerprint: "",
    },
  });
  url.searchParams.set("fingerprint", "invalid");
  expect(desktopLink(url.href, "canopy")).toBeUndefined();
  url.searchParams.delete("fingerprint");
  url.searchParams.set("web", "https://user:secret@web.example");
  expect(desktopLink(url.href, "canopy")).toBeUndefined();
});
