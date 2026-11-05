import { expect, test } from "bun:test";
import { allowedPermission } from "../src/window-permissions.ts";

const trusted = ["http://127.0.0.1:41234", "http://127.0.0.1:41235", undefined];

test("app pages may write to the clipboard and show notifications; nothing else is granted", () => {
  for (const permission of ["clipboard-sanitized-write", "notifications"]) {
    expect(allowedPermission(permission, "http://127.0.0.1:41235", trusted)).toBe(true);
    expect(allowedPermission(permission, "http://127.0.0.1:41234/settings/general", trusted)).toBe(true);
  }

  for (const permission of [
    "clipboard-read",
    "media",
    "geolocation",
    "openExternal",
    "midi",
    "pointerLock",
    "fullscreen",
    "display-capture",
    "Notifications",
    "",
  ])
    expect(allowedPermission(permission, "http://127.0.0.1:41235", trusted)).toBe(false);
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
      expect(allowedPermission(permission, url, trusted)).toBe(false);
});
