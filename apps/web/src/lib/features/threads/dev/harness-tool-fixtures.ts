import { ItemStatus, type Item } from "@canopy/contracts";
import { numbered, source, tool } from "./tool-fixture-kit.ts";

/** Claude Code tools: files, search, shell, web, tasks, MCP and unknown ones. */
export const claudeToolItems = (): Item[] => [
  tool(
    "read",
    "Read",
    { file_path: "/tmp/canopy-stack/code/apps/web/src/lib/format.ts" },
    numbered(source) + "\n\n<system-reminder>\nWhenever you read a file…\n</system-reminder>",
  ),
  tool(
    "read-range",
    "Read",
    { file_path: "/repo/README.md", offset: 40, limit: 7 },
    numbered("## Install\n\nRun `bun install`.\n\n## Test\n\nRun `bun test`.", 40),
  ),
  tool(
    "read-missing",
    "Read",
    { file_path: "/repo/missing.ts" },
    "<tool_use_error>File does not exist.</tool_use_error>",
    { isError: true },
  ),
  tool(
    "grep-files",
    "Grep",
    { pattern: "describeTool", path: "/repo/apps/web/src", glob: "*.svelte" },
    "Found 3 files\n/repo/apps/web/src/lib/a.svelte\n/repo/apps/web/src/lib/b.svelte\n/repo/apps/web/src/routes/c.svelte",
  ),
  tool(
    "grep-content",
    "Grep",
    { pattern: "TODO", path: "/repo", output_mode: "content", "-n": true, "-i": true },
    "/repo/src/a.ts:12:// TODO: handle errors\n/repo/src/a.ts:40:  // todo later\n/repo/src/b.ts:3:// TODO remove",
  ),
  tool(
    "glob",
    "Glob",
    { pattern: "**/*.test.ts", path: "/repo/packages" },
    Array.from({ length: 16 }, (_, i) => `/repo/packages/domain/src/m${i}.test.ts`).join("\n"),
  ),
  tool(
    "webfetch",
    "WebFetch",
    { url: "https://svelte.dev/docs/svelte/$state", prompt: "How do deep state proxies work?" },
    "**Deep state** — `$state` makes arrays and plain objects deeply reactive proxies.\n\n- Reading a property tracks it.\n- Writing triggers updates for readers.",
  ),
  tool(
    "todo",
    "TodoWrite",
    {
      todos: [
        { content: "Read the item views", status: "completed", activeForm: "Reading" },
        { content: "Write the registry", status: "in_progress" },
        { content: "Screenshots", status: "pending" },
      ],
    },
    "Todos have been modified successfully.",
  ),
  tool(
    "edit",
    "Edit",
    { file_path: "/repo/src/format.ts", old_string: 'return "";', new_string: "return value.trim();" },
    "The file /repo/src/format.ts has been updated.",
  ),
  tool("skill", "Skill", { skill: "design", args: "Rich tool-call rendering" }, "Launching skill: design"),
  tool(
    "mcp",
    "create_issue",
    {
      owner: "acme",
      repo: "web",
      title: "Tool calls show raw JSON",
      labels: ["ui", "enhancement"],
      assignee_id: "01a1981a-c5b8-734c-a479-d714b09c22ae",
      draft: false,
    },
    JSON.stringify([
      {
        type: "text",
        text: JSON.stringify({
          number: 412,
          html_url: "https://github.com/acme/web/issues/412",
          state: "open",
          created_at: "2026-11-02T08:19:26Z",
        }),
      },
    ]),
    { server: "github" },
  ),
  tool("unknown-running", "ToolSearch", { query: "select:WebFetch", max_results: 5 }, "", {
    status: ItemStatus.IN_PROGRESS,
  }),
];

/** Codex tools: exec scripts, patches and plans. */
export const codexToolItems = (): Item[] => [
  tool(
    "exec",
    "exec",
    {
      code: 'text(await tools.exec_command({cmd:"cat /tmp/goal-bg-output.log\\npgrep -x sleep","max_output_tokens":100}));\n',
    },
    'Script completed\nWall time 0.1 seconds\nOutput:\n\n{"chunk_id":"2c2244","wall_time_seconds":0.0000112,"exit_code":1,"original_token_count":14,"output":"cat: /tmp/goal-bg-output.log: No such file or directory\\n"}',
  ),
  tool(
    "exec-goal",
    "exec",
    {
      code: 'text(await tools.exec_command({cmd:"printf \'done\\\\n\' > goal-check.txt","workdir":"/tmp/canopy-stack/code"}));\ntext(await tools.update_goal({status:"complete"}));\n',
    },
    'Script completed\nWall time 0.1 seconds\nOutput:\n\n{"chunk_id":"22223a","wall_time_seconds":0.0000124,"exit_code":0,"original_token_count":11,"output":"/tmp/canopy-stack/code/goal-check.txt: verified\\n"}\n{"goal":{"threadId":"01a198fa-0935-77d1-9093-8d243c72323b","objective":"Create the file goal-check.txt","status":"complete","tokenBudget":300000,"tokensUsed":1512,"timeUsedSeconds":3},"remainingTokens":298488}',
  ),
  tool(
    "exec-sleep",
    "exec",
    { code: 'await tools.exec_command({cmd:"sleep 25",yield_time_ms:30000,max_output_tokens:100});\n' },
    "Script completed\nWall time 25.0 seconds\nOutput:\n",
  ),
  tool(
    "patch",
    "apply_patch",
    {
      input:
        "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-const a = 1;\n+const a = 2;\n*** Add File: docs/notes.md\n+# Notes\n+First line.\n*** End Patch",
    },
    "Done!",
  ),
  tool(
    "plan",
    "update_plan",
    {
      explanation: "Splitting the work in three.",
      plan: [
        { step: "Inspect transcripts", status: "completed" },
        { step: "Registry", status: "in_progress" },
        { step: "Verify", status: "pending" },
      ],
    },
    "Plan updated",
  ),
];
