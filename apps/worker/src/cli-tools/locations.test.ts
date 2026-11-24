import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "@canopy/testing";
import { locate } from "./locations.ts";

const tempDir = tempDirs();

describe("CLI locations", () => {
  test("finds the Windows Antigravity CLI outside PATH", () => {
    const home = tempDir("canopy-cli-location-");
    const local = join(home, "AppData", "Local");
    const bin = join(local, "agy", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "agy.exe"), "");
    expect(locate({ platform: "win32", home, env: { LOCALAPPDATA: local } }, "agy")).toEqual([
      { path: join(bin, "agy.exe"), broken: false },
    ]);
  });

  test("finds npm cmd launchers on Windows", () => {
    const directory = tempDir("canopy-cli-location-");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "claude.cmd"), "@echo off\r\n");

    expect(locate({ platform: "win32", home: directory, env: { PATH: directory } }, "claude")).toEqual([
      { path: join(directory, "claude.cmd"), broken: false },
    ]);
  });
});
