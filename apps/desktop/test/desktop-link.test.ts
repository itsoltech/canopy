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

test("OAuth returns accept only provider keys with a desktop state", () => {
  const state = `${"n".repeat(43)}.d`;
  const link = (query: string, base = "canopy://oauth/callback") => `${base}?${query}`;

  expect(desktopLink(link(`code=one-time&state=${state}&iss=https%3A%2F%2Fmcp.slack.com`), "canopy")).toEqual({
    oauth: { state, code: "one-time", error: "", issuer: "https://mcp.slack.com" },
  });
  expect(desktopLink(link(`error=access_denied&error_description=no&state=${state}`), "canopy")).toEqual({
    oauth: { state, code: "", error: "access_denied", issuer: "" },
  });

  for (const bad of [
    link(`code=x&state=${state}`, "https://oauth/callback"),
    link(`code=x&state=${state}`, "other://oauth/callback"),
    link(`code=x&state=${state}`, "canopy://oauth/elsewhere"),
    link(`code=x&state=${state}`, "canopy://oauth/callback/extra"),
    link(`code=x&state=${state}`, "canopy://user:secret@oauth/callback"),
    link(`code=x&state=${state}`, "canopy://oauth:8080/callback"),
    link(`code=x&state=${state}`, "canopy://evil/callback"),
    `${link(`code=x&state=${state}`)}#fragment`,
    link(`code=x&state=${state}&next=https%3A%2F%2Fevil.example`),
    link(`code=x&code=y&state=${state}`),
    link(`code=x&state=${"n".repeat(43)}`),
    link(`code=x&state=${"n".repeat(43)}.w.aHR0cHM6Ly9ldmlsLmV4YW1wbGU`),
    link(`code=x&state=short.d`),
    link(`state=${state}`),
    link(`code=${"x".repeat(8100)}&state=${state}`),
  ])
    expect(desktopLink(bad, "canopy")).toBeUndefined();
});
