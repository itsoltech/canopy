import { expect, test } from "bun:test";
import { parsePastedCode, pastedCode, returnState, returnTarget } from "./oauth-return.ts";

const nonce = "n".repeat(43);
const search = (state: string, extra = "") => `?code=one-time&state=${encodeURIComponent(state)}${extra}`;

test("the redirect page returns only to a Canopy callback path, never to another URL", () => {
  const web = returnState(nonce, { callback: "https://canopy.example/api/connectors/oauth/callback" });
  expect(returnTarget(search(web, "&iss=x"))).toEqual({
    desktop: false,
    url: `https://canopy.example/api/connectors/oauth/callback${search(web, "&iss=x")}`,
  });

  for (const callback of [
    "https://evil.example/elsewhere",
    "https://canopy.example/api/connectors/oauth/callback/extra",
    "https://user:secret@canopy.example/api/connectors/oauth/callback",
    "https://canopy.example/api/connectors/oauth/callback?next=https://evil.example",
    "https://canopy.example/api/connectors/oauth/callback#x",
    "javascript:alert(1)//api/connectors/oauth/callback",
    "canopy://oauth/callback",
  ])
    expect(returnTarget(search(returnState(nonce, { callback })))).toBeUndefined();

  for (const state of ["", nonce, "short.w.aHR0cHM6Ly9h", `${nonce}.w.%%%`, `${nonce}.x`, `${nonce}.w.`])
    expect(returnTarget(search(state))).toBeUndefined();
});

test("the desktop return forwards only provider keys to canopy://oauth/callback", () => {
  const state = returnState(nonce, { desktop: true });
  const target = returnTarget(search(state, "&error_description=no&extra=dropped"));
  expect(target?.desktop).toBe(true);
  const url = new URL(target!.url);
  expect(`${url.protocol}//${url.host}${url.pathname}`).toBe("canopy://oauth/callback");
  expect([...url.searchParams.keys()]).toEqual(["code", "state", "error_description"]);
});

test("a pasted code round-trips and rejects anything else", () => {
  const state = returnState(nonce, { desktop: true });
  expect(parsePastedCode(` ${pastedCode(state, "abc.def")} `)).toEqual({ state, code: "abc.def" });

  for (const text of ["", "not base64 !", btoa("no-space"), btoa(`bad-state code`), btoa(`${state} `)])
    expect(parsePastedCode(text)).toBeUndefined();
});

test("the copied redirect address works as a pasted code", () => {
  const state = returnState(nonce, { desktop: true });
  const page = `https://itsoltech.github.io/canopy/oauth/callback${search(state)}`;
  expect(parsePastedCode(page)).toEqual({ state, code: "one-time" });
  expect(parsePastedCode(search(state).slice(1))).toEqual({ state, code: "one-time" });
  expect(parsePastedCode(`${page}#top`)).toEqual({ state, code: "one-time" });

  for (const text of [
    `https://x.test/cb?code=one-time&state=bad`,
    `https://x.test/cb?state=${encodeURIComponent(state)}`,
  ])
    expect(parsePastedCode(text)).toBeUndefined();
});
