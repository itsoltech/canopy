import { expect, test } from "bun:test";
import { isWithinRoots, scratchBase, scratchCwd } from "./paths.ts";

const owner = "019a1000-0000-7000-8000-000000000001";
const thread = "019a1000-0000-7000-8000-000000000002";

test("scratch paths use stable ids, stay in the allowed root and follow the worker OS", () => {
  expect(scratchCwd(scratchBase("/data/", owner, "posix"), thread, "posix")).toBe(`/data/.open-agents/scratch/${owner}/${thread}`);
  const windows = scratchCwd(scratchBase("C:\\data", owner, "win32"), thread, "win32");
  expect(windows).toBe(`C:\\data\\.open-agents\\scratch\\${owner}\\${thread}`);
  expect(isWithinRoots(windows, ["C:\\data"], "win32")).toBe(true);
});

test("path names reject titles, separators and traversal instead of sanitizing arbitrary text", () => {
  for (const unsafe of ["../escape", "hello/world", "A thread title", "", `${thread}/../other`]) {
    expect(() => scratchBase("/data", unsafe, "posix")).toThrow();
    expect(() => scratchCwd("/data", unsafe, "posix")).toThrow();
  }
  expect(() => scratchBase("relative", owner, "posix")).toThrow();
});
