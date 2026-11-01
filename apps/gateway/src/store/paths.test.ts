import { describe, expect, test } from "bun:test";
import { isAbsolutePath, isWithinRoots, normalizePath, pathKey, pathStyle } from "./paths.ts";

describe("worker paths", () => {
  test("style follows the worker's OS, else the path", () => {
    expect(pathStyle("win32", "/x")).toBe("win32");
    expect(pathStyle("darwin", "C:\\x")).toBe("posix");
    expect(pathStyle("", "C:\\x")).toBe("win32");
    expect(pathStyle("", "/x")).toBe("posix");
  });

  test("normalization", () => {
    expect(normalizePath("/repo/", "posix")).toBe("/repo");
    expect(normalizePath("/repo/a/../b", "posix")).toBe("/repo/b");
    expect(normalizePath("/", "posix")).toBe("/");
    expect(normalizePath("c:/code/app/", "win32")).toBe("c:\\code\\app");
    expect(normalizePath("C:\\", "win32")).toBe("C:\\");
    expect(isAbsolutePath("relative/x", "posix")).toBe(false);
    expect(isAbsolutePath("\\no-drive", "win32")).toBe(false);
    expect(isAbsolutePath("\\\\server\\share", "win32")).toBe(true);
  });

  test("case-insensitive keys on Windows and macOS", () => {
    expect(pathKey("C:\\Code", "win32", "win32")).toBe(pathKey("c:/code/", "win32", "win32"));
    expect(pathKey("/Users/A/Repo", "posix", "darwin")).toBe(pathKey("/users/a/repo", "posix", "darwin"));
    expect(pathKey("/Repo", "posix", "linux")).not.toBe(pathKey("/repo", "posix", "linux"));
  });

  test("POSIX roots", () => {
    expect(isWithinRoots("/repo", ["/repo"], "posix")).toBe(true);
    expect(isWithinRoots("/repo/a/b", ["/repo/"], "posix")).toBe(true);
    expect(isWithinRoots("/repo/..dots", ["/repo"], "posix")).toBe(true);
    expect(isWithinRoots("/repo-other", ["/repo"], "posix")).toBe(false);
    expect(isWithinRoots("/repo/../etc", ["/repo"], "posix")).toBe(false);
    expect(isWithinRoots("/etc", [], "posix")).toBe(false);
  });

  test("Windows roots", () => {
    expect(isWithinRoots("C:\\code\\app", ["C:\\code"], "win32")).toBe(true);
    expect(isWithinRoots("c:/CODE/app", ["C:\\code"], "win32")).toBe(true);
    expect(isWithinRoots("D:\\code", ["C:\\code"], "win32")).toBe(false);
    expect(isWithinRoots("C:\\codex", ["C:\\code"], "win32")).toBe(false);
  });
});
