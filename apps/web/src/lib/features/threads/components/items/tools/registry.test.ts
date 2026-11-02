import { describe, expect, test } from "bun:test";
import { describeTool, hintOf, shellCommand, todos, type ToolCallFacts } from "./registry.ts";

const call = (name: string, input: unknown, extra: Partial<ToolCallFacts> = {}): ToolCallFacts => ({
  server: "",
  name,
  inputJson: JSON.stringify(input),
  output: "",
  isError: false,
  running: false,
  ...extra,
});

describe("describeTool", () => {
  test("Read: file name, full path in the tooltip, line range", () => {
    const look = describeTool(call("Read", { file_path: "/repo/src/app.ts", offset: 10, limit: 40 }));
    expect(look).toMatchObject({ title: "Read", subject: "app.ts", subjectTitle: "/repo/src/app.ts", mono: true, detail: "lines 10–49", body: "read" });
    expect(describeTool(call("Read", { file_path: "/a.ts" }, { output: "1\tx\n2\ty" })).detail).toBe("2 lines");
    expect(describeTool(call("Read", { file_path: "/a.ts" }, { running: true })).title).toBe("Reading");
  });

  test("Grep and Glob count what they found", () => {
    expect(describeTool(call("Grep", { pattern: "TODO" }, { output: "Found 2 files\na.ts\nb.ts" }))).toMatchObject({ title: "Searched for", subject: "TODO", detail: "2 files", body: "search" });
    expect(describeTool(call("Grep", { pattern: "x", output_mode: "content" }, { output: "a.ts:1:x\na.ts:5:x" })).detail).toBe("2 matches in 1 file");
    expect(describeTool(call("Grep", { pattern: "x" }, { output: "No files found" })).detail).toBe("no matches");
    expect(describeTool(call("Glob", { pattern: "**/*.ts" }, { output: "a.ts\nb.ts\nc.ts" }))).toMatchObject({ title: "Found files", detail: "3 files", body: "files" });
  });

  test("Codex code-mode cell: the command it runs", () => {
    const look = describeTool(
      call("exec", { code: 'await tools.exec_command({cmd:"sleep 25",yield_time_ms:30000});' }, { output: "Script completed\nWall time 25.0 seconds\nOutput:\n" }),
    );
    expect(look).toMatchObject({ title: "Ran a script", subject: "sleep 25", mono: true, detail: "25s", body: "script" });
    expect(describeTool(call("exec", { code: "text(await tools.list_agents({}));" })).subject).toBe("List agents");
  });

  test("apply_patch names its files", () => {
    const look = describeTool(call("apply_patch", { input: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** End Patch" }));
    expect(look).toMatchObject({ title: "Edited", subject: "a.ts", body: "patch" });
  });

  test("to-do lists count what is done", () => {
    const input = { todos: [{ content: "a", status: "completed" }, { content: "b", status: "pending" }] };
    expect(describeTool(call("TodoWrite", input))).toMatchObject({ title: "Updated the to-do list", detail: "1 of 2 done", body: "todo" });
    expect(todos({ plan: [{ step: "x", status: "in_progress" }] })).toEqual([{ text: "x", status: "in_progress" }]);
  });

  test("MCP tools: server and tool in words, first readable argument", () => {
    const look = describeTool(call("create_issue", { repo: "a/b", title: "Bug in login" }, { server: "github" }));
    expect(look).toMatchObject({ title: "GitHub · Create issue", subject: "a/b", icon: "code-bracket", body: "generic" });
    // An MCP tool named like a built-in is still an MCP tool.
    expect(describeTool(call("Read", { file_path: "/x" }, { server: "fs" })).body).toBe("generic");
  });

  test("unknown tools: name in words, ids are never the subject", () => {
    const look = describeTool(call("frobnicate_widget", { id: "01a198ce-fe6b-757d-a524-4dd87fb54c63", label: "blue" }));
    expect(look).toMatchObject({ title: "Frobnicate widget", subject: "blue", body: "generic", icon: "wrench" });
  });

  test("invalid input JSON still has a look", () => {
    expect(describeTool({ ...call("Read", {}), inputJson: "not json" })).toMatchObject({ title: "Read", subject: "" });
  });
});

describe("helpers", () => {
  test("shellCommand accepts text or argv", () => {
    expect(shellCommand({ cmd: "ls -la" })).toBe("ls -la");
    expect(shellCommand({ command: ["bash", "-lc", "ls"] })).toBe("bash -lc ls");
  });

  test("hintOf skips ids and long text", () => {
    expect(hintOf({ a: "toolu_01FoEfXKGNKxkUhjKeTgi13K", b: "x".repeat(300), c: "short" })).toBe("short");
    expect(hintOf({ n: 1 })).toBe("");
  });
});
