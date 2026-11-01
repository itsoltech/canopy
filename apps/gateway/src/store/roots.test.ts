import { describe, expect, test } from "bun:test";
import { isWithinRoots } from "./store.ts";

describe("isWithinRoots", () => {
  test("POSIX roots", () => {
    expect(isWithinRoots("/repo", ["/repo"])).toBe(true);
    expect(isWithinRoots("/repo/a/b", ["/repo/"])).toBe(true);
    expect(isWithinRoots("/repo/..dots", ["/repo"])).toBe(true);
    expect(isWithinRoots("/repo-other", ["/repo"])).toBe(false);
    expect(isWithinRoots("/repo/../etc", ["/repo"])).toBe(false);
    expect(isWithinRoots("/etc", [])).toBe(false);
  });

  test("Windows roots", () => {
    expect(isWithinRoots("C:\\code\\app", ["C:\\code"])).toBe(true);
    expect(isWithinRoots("c:/code/app", ["C:\\code"])).toBe(true);
    expect(isWithinRoots("D:\\code", ["C:\\code"])).toBe(false);
    expect(isWithinRoots("C:\\codex", ["C:\\code"])).toBe(false);
  });
});
