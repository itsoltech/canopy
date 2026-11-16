import { describe, expect, test } from "bun:test";
import { windowsCommand } from "./windows-command.ts";

describe("Windows CLI launchers", () => {
  test("runs cmd launchers through ComSpec", () => {
    expect(
      windowsCommand(
        ["C:\\Program Files\\Canopy\\claude.cmd", "--version"],
        {
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
        },
        "win32",
      ),
    ).toEqual([
      "C:\\Windows\\System32\\cmd.exe",
      "/d",
      "/s",
      "/c",
      '"C:\\Program Files\\Canopy\\claude.cmd" --version',
    ]);
  });

  test("leaves native executables unchanged", () => {
    expect(windowsCommand(["C:\\Tools\\claude.exe", "--version"], {}, "win32")).toEqual([
      "C:\\Tools\\claude.exe",
      "--version",
    ]);
  });
});
