import { describe, expect, test } from "bun:test";
import { isAbsolutePath, isWithinWorkspace, normalizePath, pathKey, pathStyle } from "./paths.ts";

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

  test("POSIX workspace subdirectories", () => {
    expect(isWithinWorkspace("/repo", "/repo", "posix")).toBe(true);
    expect(isWithinWorkspace("/repo/a/b", "/repo/", "posix")).toBe(true);
    expect(isWithinWorkspace("/repo/..dots", "/repo", "posix")).toBe(true);
    expect(isWithinWorkspace("/repo-other", "/repo", "posix")).toBe(false);
    expect(isWithinWorkspace("/repo/../etc", "/repo", "posix")).toBe(false);
  });

  test("Windows workspace subdirectories", () => {
    expect(isWithinWorkspace("C:\\code\\app", "C:\\code", "win32")).toBe(true);
    expect(isWithinWorkspace("c:/CODE/app", "C:\\code", "win32")).toBe(true);
    expect(isWithinWorkspace("D:\\code", "C:\\code", "win32")).toBe(false);
    expect(isWithinWorkspace("C:\\codex", "C:\\code", "win32")).toBe(false);
  });
});
