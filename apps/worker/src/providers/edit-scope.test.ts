import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "@canopy/testing";
import { workspaceEdit } from "./edit-scope.ts";

const temporary = tempDirs();

test("edits stay allowed inside the workspace, including new files, and are refused outside it", () => {
  const base = temporary("canopy-edit-scope-");
  const cwd = join(base, "repo");
  const outside = join(base, "outside");
  mkdirSync(join(cwd, "src"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(cwd, "src", "app.ts"), "export {};\n");

  expect(workspaceEdit(cwd, "src/app.ts")).toBe(true);
  expect(workspaceEdit(cwd, join(cwd, "src", "app.ts"))).toBe(true);
  expect(workspaceEdit(cwd, "src/new/deeper/file.ts")).toBe(true);
  expect(workspaceEdit(cwd, "src/../src/app.ts")).toBe(false);
  expect(workspaceEdit(cwd, join(outside, "file.txt"))).toBe(false);
  expect(workspaceEdit(cwd, "")).toBe(false);

  try {
    symlinkSync(outside, join(cwd, "linked"), "dir");
  } catch {
    return; // Creating symlinks needs a privilege on Windows.
  }

  expect(workspaceEdit(cwd, "linked/file.txt")).toBe(false);
});
