import { expect, test } from "bun:test";
import { scratchBase, scratchCwd } from "./paths.ts";

const owner = "019a1000-0000-7000-8000-000000000001";
const thread = "019a1000-0000-7000-8000-000000000002";

test("scratch paths use stable ids and the worker-reported base and OS", () => {
  expect(scratchCwd(scratchBase("/data/scratch/", owner, "posix"), thread, "posix")).toBe(`/data/scratch/${owner}/${thread}`);
  const windows = scratchCwd(scratchBase("C:\\data\\scratch", owner, "win32"), thread, "win32");
  expect(windows).toBe(`C:\\data\\scratch\\${owner}\\${thread}`);
});

test("path names reject titles, separators and traversal instead of sanitizing arbitrary text", () => {
  for (const unsafe of ["../escape", "hello/world", "A thread title", "", `${thread}/../other`]) {
    expect(() => scratchBase("/data", unsafe, "posix")).toThrow();
    expect(() => scratchCwd("/data", unsafe, "posix")).toThrow();
  }
  expect(() => scratchBase("relative", owner, "posix")).toThrow();
});
