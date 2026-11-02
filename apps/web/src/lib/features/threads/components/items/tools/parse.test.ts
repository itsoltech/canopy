import { describe, expect, test } from "bun:test";
import { parseFileList, parseGrepOutput, parseNumberedLines, parsePatch, parseScriptCalls, parseScriptOutput, replacementDiff, shortUrl, stripReminders } from "./parse.ts";

describe("parseNumberedLines", () => {
  test("cat -n output with tabs or arrows", () => {
    expect(parseNumberedLines("     1\tstart\n     2\tend\n     3\t")).toEqual({ start: 1, lines: ["start", "end", ""] });
    expect(parseNumberedLines("  10→a\n  11→b")).toEqual({ start: 10, lines: ["a", "b"] });
  });

  test("reminders for the model are left out", () => {
    expect(parseNumberedLines("1\tx\n\n<system-reminder>\nnote\n</system-reminder>\n")).toEqual({ start: 1, lines: ["x"] });
    expect(stripReminders("a\n<system-reminder>b</system-reminder>")).toBe("a");
  });

  test("other text is not numbered lines", () => {
    expect(parseNumberedLines("File does not exist.")).toBeUndefined();
    expect(parseNumberedLines("")).toBeUndefined();
  });
});

describe("parseGrepOutput", () => {
  test("file list", () => {
    expect(parseGrepOutput("Found 2 files\nsrc/a.ts\nsrc/b.ts", "files_with_matches").map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("counts", () => {
    expect(parseGrepOutput("src/a.ts:4\nsrc/b.ts:1", "count")).toEqual([
      { path: "src/a.ts", count: 4, lines: [] },
      { path: "src/b.ts", count: 1, lines: [] },
    ]);
  });

  test("content grouped by file", () => {
    const files = parseGrepOutput("src/a.ts:12:const x = 1;\nsrc/a.ts-13-context\n--\nsrc/b.ts:3:y", "content");
    expect(files).toHaveLength(2);
    expect(files[0]).toEqual({ path: "src/a.ts", count: 2, lines: [{ line: 12, text: "const x = 1;" }, { line: 13, text: "context" }] });
  });

  test("no matches", () => {
    expect(parseGrepOutput("No files found", "files_with_matches")).toEqual([]);
    expect(parseGrepOutput("No matches found", "content")).toEqual([]);
  });
});

describe("parseFileList", () => {
  test("paths, without notes", () => {
    expect(parseFileList("/a/b.ts\n/a/c.ts\n(Results are truncated. Consider using a more specific path or pattern.)")).toEqual(["/a/b.ts", "/a/c.ts"]);
    expect(parseFileList("No files found")).toEqual([]);
  });
});

describe("Codex code-mode cells", () => {
  test("tools and commands the script calls", () => {
    const code = 'text(await tools.exec_command({cmd:"cat /tmp/x.log\\npgrep -x sleep","max_output_tokens":100}));\ntext(await tools.update_goal({status:"complete"}));\n';
    expect(parseScriptCalls(code)).toEqual([
      { tool: "exec_command", command: "cat /tmp/x.log\npgrep -x sleep" },
      { tool: "update_goal", command: undefined },
    ]);
    expect(parseScriptCalls("text(await tools.list_agents({}));")).toEqual([{ tool: "list_agents", command: undefined }]);
  });

  test("result: wall time, command output and other JSON", () => {
    const output =
      'Script completed\nWall time 0.1 seconds\nOutput:\n\n{"chunk_id":"2c2244","wall_time_seconds":0.0000112,"exit_code":1,"original_token_count":14,"output":"cat: nope\\n"}\n{"agents":[],"note":"x"}';
    const result = parseScriptOutput(output)!;
    expect(result.failed).toBe(false);
    expect(result.wallSeconds).toBe(0.1);
    expect(result.parts).toEqual([
      { kind: "command", output: "cat: nope\n", exitCode: 1, running: false },
      { kind: "json", value: { agents: [], note: "x" } },
    ]);
  });

  test("a process still running and plain text", () => {
    const result = parseScriptOutput('Script completed\nWall time 1.2 seconds\nOutput:\n\n{"chunk_id":"36be2e","wall_time_seconds":1.0,"session_id":26574,"output":""}\nhello')!;
    expect(result.parts).toEqual([
      { kind: "command", output: "", exitCode: undefined, running: true },
      { kind: "text", text: "hello" },
    ]);
  });

  test("another shape is no script result", () => {
    expect(parseScriptOutput("plain")).toBeUndefined();
    expect(parseScriptOutput("Script failed: boom\nOutput:\n")?.failed).toBe(true);
  });
});

describe("parsePatch", () => {
  test("files with their diffs", () => {
    const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** Add File: b.md\n+hello\n*** Delete File: c.txt\n*** End Patch";
    expect(parsePatch(patch)).toEqual([
      { path: "src/a.ts", kind: "update", movePath: "", diff: "@@\n-old\n+new" },
      { path: "b.md", kind: "add", movePath: "", diff: "+hello" },
      { path: "c.txt", kind: "delete", movePath: "", diff: "" },
    ]);
  });

  test("moves", () => {
    expect(parsePatch("*** Update File: a.ts\n*** Move to: b.ts\n@@\n x")[0]).toMatchObject({ kind: "move", movePath: "b.ts" });
  });
});

describe("small helpers", () => {
  test("replacementDiff", () => {
    expect(replacementDiff("a\nb", "c")).toBe("-a\n-b\n+c");
    expect(replacementDiff("", "c")).toBe("+c");
  });

  test("shortUrl", () => {
    expect(shortUrl("https://www.example.com/docs/a/")).toBe("example.com/docs/a");
    expect(shortUrl("https://example.com/")).toBe("example.com");
    expect(shortUrl("not a url")).toBe("not a url");
  });
});
