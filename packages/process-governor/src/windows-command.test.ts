import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "./index.ts";
import { windowsCommand } from "./windows-command.ts";

describe("Windows CLI launchers", () => {
  test("passes a batch command through ComSpec without re-quoting it", () => {
    expect(
      windowsCommand(
        ["C:\\Program Files\\Canopy\\codex.cmd", "--version"],
        { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
        "win32",
      ),
    ).toEqual({
      argv: [
        "C:\\Windows\\System32\\cmd.exe",
        "/d",
        "/v:off",
        "/s",
        "/c",
        '""C:\\Program Files\\Canopy\\codex.cmd" --version"',
      ],
      windowsVerbatimArguments: true,
    });
  });

  test("leaves native executable arguments to the runtime", () => {
    const argv = ["C:\\Program Files\\Codex\\codex.exe", "-c", 'model_provider="openai"'];
    expect(windowsCommand(argv, {}, "win32")).toEqual({ argv, windowsVerbatimArguments: false });
  });

  test.skipIf(process.platform !== "win32")("preserves arguments through an npm launcher with spaces", async () => {
    const dir = mkdtempSync(join(tmpdir(), "Canopy CLI with spaces "));

    try {
      const shim = join(dir, "codex.cmd");
      const script = join(dir, "argv.js");
      writeFileSync(script, "console.log(JSON.stringify(process.argv.slice(2)));\n");
      writeFileSync(
        shim,
        [
          "@ECHO off",
          "SETLOCAL",
          `SET "_prog=${process.execPath}"`,
          `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%" "${script}" %*`,
          "",
        ].join("\r\n"),
      );

      const args = [
        "app-server",
        "-c",
        'model_provider="openai"',
        "-c",
        'model_providers.test.name="CLIProxyAPI (fixture)"',
        "-c",
        'skills.config=[{path="C:\\\\Program Files\\\\SKILL.md",enabled=false}]',
        "-c",
        'model_providers.test.http_headers."X-Test"="a & b | %TEMP% ^ !"',
        "C:\\path with spaces\\",
        "",
      ];

      const argv = [shim, ...args];
      const command = windowsCommand(argv);

      const child = Bun.spawn([...command.argv], {
        windowsVerbatimArguments: command.windowsVerbatimArguments,
        stdout: "pipe",
        stderr: "pipe",
      });

      const [exit, output, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);

      expect({ exit, output: output.trim(), error }).toEqual({ exit: 0, output: JSON.stringify(args), error: "" });

      const probe = await runProcess({ argv }, { kind: "probe" });
      expect({ ...probe, stdout: probe.stdout.trim() }).toEqual({ code: 0, stdout: JSON.stringify(args), stderr: "" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
