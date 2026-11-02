import { expect, test } from "bun:test";
import { isModuleFetchError, UpdateNotice } from "./updates.ts";

test("a new version announces once without reloading or changing the current document", () => {
  let announcements = 0;
  const notice = new UpdateNotice(() => announcements++);
  notice.detect(false);
  expect(notice.available).toBe(false);
  notice.detect(true);
  notice.detect(true);
  notice.detect(false, new TypeError("Failed to fetch dynamically imported module: /old.js"));
  expect(notice.available).toBe(true);
  expect(announcements).toBe(1);
});

test("chunk failures offer the same recovery, including wrapped failures", () => {
  for (const message of ["Failed to fetch dynamically imported module: /a.js", "error loading dynamically imported module", "Importing a module script failed.", "Unable to preload CSS for /a.css", "Loading chunk 12 failed."]) {
    const notice = new UpdateNotice(() => {});
    notice.detect(false, new Error("Navigation failed", { cause: new Error(message) }));
    expect(notice.available).toBe(true);
  }
  expect(isModuleFetchError(new Error("Failed to fetch"))).toBe(false);
  expect(isModuleFetchError(new Error("Invalid project"))).toBe(false);
});
