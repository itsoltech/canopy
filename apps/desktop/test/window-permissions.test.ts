import { expect, test } from "bun:test";
import { allowedPermission } from "../src/window-permissions.ts";

const trusted = ["http://127.0.0.1:41234", "http://127.0.0.1:41235", undefined];

test("app pages may write to the clipboard; nothing else is granted", () => {
  expect(allowedPermission("clipboard-sanitized-write", "http://127.0.0.1:41235", trusted)).toBe(true);
  expect(allowedPermission("clipboard-sanitized-write", "http://127.0.0.1:41234/settings/projects", trusted)).toBe(
    true,
  );

  for (const permission of ["clipboard-read", "media", "notifications", "geolocation", "openExternal"])
    expect(allowedPermission(permission, "http://127.0.0.1:41235", trusted)).toBe(false);
});

test("other origins and malformed URLs cannot write to the clipboard", () => {
  for (const url of ["https://example.com", "http://127.0.0.1:9999", "http://localhost:41235", "", "not a url"])
    expect(allowedPermission("clipboard-sanitized-write", url, trusted)).toBe(false);
});
