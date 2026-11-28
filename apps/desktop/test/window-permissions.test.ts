import { expect, test } from "bun:test";
import { allowedPermission } from "../src/window-permissions.ts";

const setupOrigin = "http://127.0.0.1:41234";
const webOrigin = "http://127.0.0.1:41235";
const thread = `${webOrigin}/threads/123`;
const app = { setupOrigin, webOrigin, mainFrameUrl: thread };

test("app and setup pages may write to the clipboard and show notifications", () => {
  for (const permission of ["clipboard-sanitized-write", "notifications"]) {
    expect(allowedPermission(permission, thread, app)).toBe(true);
    const mainFrameUrl = `${setupOrigin}/desktop`;
    expect(allowedPermission(permission, mainFrameUrl, { setupOrigin, webOrigin: undefined, mainFrameUrl })).toBe(true);
  }
});

test("only the application main frame may request full screen", () => {
  expect(allowedPermission("fullscreen", thread, app)).toBe(true);
  expect(allowedPermission("fullscreen", webOrigin, app)).toBe(true);
  expect(allowedPermission("fullscreen", thread, { ...app, mainFrameUrl: undefined })).toBe(false);
  expect(allowedPermission("fullscreen", thread, { ...app, webOrigin: undefined })).toBe(false);

  for (const page of [
    `${webOrigin}/desktop?settings=1`,
    `${setupOrigin}/desktop`,
    "https://example.com",
    "about:blank",
  ]) {
    expect(allowedPermission("fullscreen", page, app)).toBe(false);
    expect(allowedPermission("fullscreen", webOrigin, { ...app, mainFrameUrl: page })).toBe(false);
  }
});

test("app pages are denied other browser permissions", () => {
  for (const permission of [
    "clipboard-read",
    "media",
    "geolocation",
    "openExternal",
    "midi",
    "pointerLock",
    "automatic-fullscreen",
    "display-capture",
    "Notifications",
    "",
  ])
    expect(allowedPermission(permission, thread, app)).toBe(false);
});

test("other origins and malformed URLs get no permission", () => {
  for (const permission of ["clipboard-sanitized-write", "notifications"])
    for (const url of [
      "https://example.com",
      "http://127.0.0.1:9999",
      "http://localhost:41235",
      "https://127.0.0.1:41235",
      "",
      "not a url",
    ])
      expect(allowedPermission(permission, url, app)).toBe(false);
});
