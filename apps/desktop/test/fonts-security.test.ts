import { expect, test } from "bun:test";
import { allowedFontAccess } from "../src/window-permissions.ts";
import { fontFamilies, fontStack, localFontFamily, quoteFontFamily } from "@canopy/ui/fonts";

test("font permission excludes setup, other origins, subframes and missing application origins", () => {
  const app = "http://127.0.0.1:41235";
  expect(allowedFontAccess(`${app}/settings/typography`, app)).toBe(true);

  for (const url of ["http://127.0.0.1:41234/desktop", "https://example.com", "http://localhost:41235", "bad-url"])
    expect(allowedFontAccess(url, app)).toBe(false);

  expect(allowedFontAccess(app, undefined)).toBe(false);
  expect(allowedFontAccess(app, app, false)).toBe(false);
});

test("stored family names cannot escape CSS strings or replace the fallback stack", () => {
  const family = 'Example \\"; color: red; font-family: "Other';

  for (const kind of ["interface", "mono"] as const) {
    const fallback = fontStack(kind === "mono" ? "system" : "canopy", kind);
    expect(fontStack(`local:${family}`, kind)).toBe(`${quoteFontFamily(family)}, ${fallback}`);
    expect(quoteFontFamily(family)).toBe('"Example \\\\\\"; color: red; font-family: \\"Other"');

    for (const invalid of ["local:\nInjected", "local:Font\u0000", `local:${"x".repeat(201)}`, "local: Font "])
      expect(fontStack(invalid, kind)).toBe(fallback);
  }
});

test("enumeration collapses style families and rejects control characters from native output", () => {
  expect(fontFamilies([" Inter ", "Inter", "INTER", "Menlo", "Font\u0000", "", "Georgia"])).toEqual([
    "Georgia",
    "Inter",
    "Menlo",
  ]);
  expect(localFontFamily("local:Family, With Comma")).toBe("Family, With Comma");
});
