import { describe, expect, test } from "bun:test";
import { terminalCwd, terminalTitle } from "../src/lib/shared/ui/terminal.ts";
import { terminalAnsi, terminalPlainText } from "../src/lib/shared/ui/terminal-ansi.ts";

describe("terminal command title", () => {
  test("unwraps shell quoting, strips paths and skips incidental python flags", () => {
    expect(terminalTitle(`/usr/bin/bash -lc "python3 -u -c 'import datetime,json; print(\\\"hello\\\")'"`)).toBe("python3 -c …");
    expect(terminalTitle(`sh -c 'node -e "console.log(1)"'`)).toBe("node -e …");
    expect(terminalTitle(`bash -l -c 'sh -c "sleep 30"'`)).toBe("sleep 30");
    expect(terminalTitle(`/usr/bin/python3 script.py --verbose`)).toBe("python3 script.py …");
  });
  test("prefers a harness description, but derives command-shaped descriptions", () => {
    expect(terminalTitle("python3 -u worker.py", "Watch build output\nDetails")).toBe("Watch build output");
    const command = `bash -lc 'python3 -c "print(1)"'`;
    expect(terminalTitle(command, command)).toBe("python3 -c …");
    expect(terminalTitle("")).toBe("Background task");
    expect(terminalTitle(`node ${"x".repeat(200)}`)).toHaveLength(62);
  });
});

describe("terminal cwd", () => {
  test("shortens remote home paths, preserving path boundaries", () => {
    expect(terminalCwd("/home/alice/work/app")).toBe("~/work/app");
    expect(terminalCwd("/Users/alice")).toBe("~");
    expect(terminalCwd("/root/project")).toBe("~/project");
    expect(terminalCwd("/rooted/project")).toBe("/rooted/project");
    expect(terminalCwd("/tmp/app")).toBe("/tmp/app");
  });
  test("keeps both ends of a long cwd within the requested width", () => {
    const path = terminalCwd("/home/alice/projects/" + "nested/".repeat(20) + "terminal-demo", 32);
    expect(path).toHaveLength(32);
    expect(path.startsWith("~/projects/")).toBe(true);
    expect(path.endsWith("terminal-demo")).toBe(true);
    expect(path).toContain("…");
  });
});

describe("terminal ANSI", () => {
  test("renders basic, bright, indexed and truecolour SGR and resets", () => {
    const tokens = terminalAnsi("\x1b[1;31mred\x1b[0m plain \x1b[94mblue\x1b[38;5;46mgreen\x1b[48;2;10;20;30mbackground")[0]!;
    expect(tokens[0]).toMatchObject({ text: "red", foreground: "#f87171", bold: true });
    expect(tokens[1]).toEqual({ text: " plain " });
    expect(tokens[2]?.foreground).toBe("#93c5fd");
    expect(tokens[3]?.foreground).toBe("rgb(0, 255, 0)");
    expect(tokens[4]?.background).toBe("rgb(10, 20, 30)");
  });
  test("keeps styles across lines and resets individual attributes", () => {
    const lines = terminalAnsi("\x1b[2;3;4;32mfirst\nsecond\x1b[22;23;24;39m normal\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]?.[0]).toMatchObject({ text: "second", dim: true, italic: true, underline: true, foreground: "#4ade80" });
    expect(lines[1]?.[1]).toMatchObject({ text: " normal", dim: false, italic: false, underline: false });
    expect(lines[1]?.[1]?.foreground).toBeUndefined();
  });
  test("strips cursor, OSC links/clipboard, DCS and incomplete sequences; preserves literal HTML", () => {
    const output = "\x1b[2J\x1b[H\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x07\x1b]52;c;secret\x07\x1bPprivate\x1b\\<script>alert(1)</script>\r\n";
    expect(terminalPlainText(output)).toBe("link<script>alert(1)</script>\n");
    expect(terminalPlainText("ready\x1b[38;2;")).toBe("ready");
    expect(terminalPlainText("ready\x1b]52;c;unfinished")).toBe("ready");
    expect(terminalPlainText("\x9b31mred\x9b0m")).toBe("red");
    expect(terminalPlainText("\x1b7saved\x1b8\x1bc\x90private\x9cvisible")).toBe("savedvisible");
  });
});
