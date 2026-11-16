import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@canopy/testing";
import { locate } from "./locations.ts";

describe("CLI locations", () => {
  test("finds npm cmd launchers on Windows", () => {
    const directory = tempDir("canopy-cli-location-");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "claude.cmd"), "@echo off\r\n");

    expect(locate({ platform: "win32", home: directory, env: { PATH: directory } }, "claude")).toEqual([
      { path: join(directory, "claude.cmd"), broken: false },
    ]);
  });
});
