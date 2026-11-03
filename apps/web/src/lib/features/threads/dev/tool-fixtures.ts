import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { InteractionKind, ItemSchema, ItemStatus, ui, type Item } from "@canopy/contracts";

type ItemContent = MessageInitShape<typeof ItemSchema>["content"];

/**
 * Tool calls of every kind the timeline knows, with made-up but realistic inputs and results (shapes taken
 * from real Claude Code, Codex and agent bus transcripts), for the dev gallery (`/dev/tool-calls`).
 */
export const GALLERY_THREAD_ID = "01a19b4d-1bd5-77e2-aa45-1a2e404c1b89";
const SIDE = "01a19868-b267-75e4-9a45-8a566cb687ce";
const OTHER = "01a198ce-fe6b-757d-a524-4dd87fb54c63";

const item = (id: string, content: ItemContent, status = ItemStatus.COMPLETED): Item => create(ItemSchema, { itemId: id, status, content });
const tool = (id: string, name: string, input: unknown, output: string, extra: { server?: string; isError?: boolean; status?: ItemStatus } = {}): Item =>
  item(id, { case: "toolCall", value: { name, server: extra.server ?? "", inputJson: JSON.stringify(input), output, isError: extra.isError ?? false } }, extra.status);
const bus = (id: string, toolName: string, args: unknown, result: unknown, extra: { isError?: boolean; status?: ItemStatus; target?: string } = {}): Item =>
  item(
    id,
    {
      case: "agentBusCall",
      value: {
        callId: id,
        toolName,
        argumentsJson: JSON.stringify(args),
        resultJson: typeof result === "string" ? result : JSON.stringify(result),
        isError: extra.isError ?? false,
        targetThreadId: extra.target ?? "",
      },
    },
    extra.status,
  );

const source = `import { describeTool } from "./registry.ts";

/** Formats a value for people. */
export function format(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}
`;
const numbered = (text: string, start = 1) =>
  text
    .split("\n")
    .map((line, i) => `${String(start + i).padStart(6)}\t${line}`)
    .join("\n");

const summary = (title: string, status: string, last: string, extra: Record<string, unknown> = {}) => ({
  thread_id: title === "Lister" ? SIDE : OTHER,
  title,
  kind: "side",
  parent_thread_id: GALLERY_THREAD_ID,
  status,
  settled: status !== "running",
  queued_turns: 0,
  waiting_for_parent: 0,
  waiting_for_user: 0,
  model: "gpt-6.1-sol",
  effort: "high",
  permission_mode: "read_only",
  last_message: last,
  ...extra,
});

export function toolGallery(): { title: string; items: Item[] }[] {
  return [
    {
      title: "Claude Code",
      items: [
        tool("read", "Read", { file_path: "/tmp/canopy-stack/code/apps/web/src/lib/format.ts" }, numbered(source) + "\n\n<system-reminder>\nWhenever you read a file…\n</system-reminder>"),
        tool("read-range", "Read", { file_path: "/repo/README.md", offset: 40, limit: 7 }, numbered("## Install\n\nRun `bun install`.\n\n## Test\n\nRun `bun test`.", 40)),
        tool("read-missing", "Read", { file_path: "/repo/missing.ts" }, "<tool_use_error>File does not exist.</tool_use_error>", { isError: true }),
        tool("grep-files", "Grep", { pattern: "describeTool", path: "/repo/apps/web/src", glob: "*.svelte" }, "Found 3 files\n/repo/apps/web/src/lib/a.svelte\n/repo/apps/web/src/lib/b.svelte\n/repo/apps/web/src/routes/c.svelte"),
        tool(
          "grep-content",
          "Grep",
          { pattern: "TODO", path: "/repo", output_mode: "content", "-n": true, "-i": true },
          "/repo/src/a.ts:12:// TODO: handle errors\n/repo/src/a.ts:40:  // todo later\n/repo/src/b.ts:3:// TODO remove",
        ),
        tool("glob", "Glob", { pattern: "**/*.test.ts", path: "/repo/packages" }, Array.from({ length: 16 }, (_, i) => `/repo/packages/domain/src/m${i}.test.ts`).join("\n")),
        tool(
          "webfetch",
          "WebFetch",
          { url: "https://svelte.dev/docs/svelte/$state", prompt: "How do deep state proxies work?" },
          "**Deep state** — `$state` makes arrays and plain objects deeply reactive proxies.\n\n- Reading a property tracks it.\n- Writing triggers updates for readers.",
        ),
        tool("todo", "TodoWrite", { todos: [{ content: "Read the item views", status: "completed", activeForm: "Reading" }, { content: "Write the registry", status: "in_progress" }, { content: "Screenshots", status: "pending" }] }, "Todos have been modified successfully."),
        tool("edit", "Edit", { file_path: "/repo/src/format.ts", old_string: 'return "";', new_string: "return value.trim();" }, "The file /repo/src/format.ts has been updated."),
        tool("skill", "Skill", { skill: "design", args: "Rich tool-call rendering" }, "Launching skill: design"),
        tool(
          "mcp",
          "create_issue",
          { owner: "acme", repo: "web", title: "Tool calls show raw JSON", labels: ["ui", "enhancement"], assignee_id: "01a1981a-c5b8-734c-a479-d714b09c22ae", draft: false },
          JSON.stringify([{ type: "text", text: JSON.stringify({ number: 412, html_url: "https://github.com/acme/web/issues/412", state: "open", created_at: "2026-11-02T08:19:26Z" }) }]),
          { server: "github" },
        ),
        tool("unknown-running", "ToolSearch", { query: "select:WebFetch", max_results: 5 }, "", { status: ItemStatus.IN_PROGRESS }),
      ],
    },
    {
      title: "Codex",
      items: [
        tool(
          "exec",
          "exec",
          { code: 'text(await tools.exec_command({cmd:"cat /tmp/goal-bg-output.log\\npgrep -x sleep","max_output_tokens":100}));\n' },
          'Script completed\nWall time 0.1 seconds\nOutput:\n\n{"chunk_id":"2c2244","wall_time_seconds":0.0000112,"exit_code":1,"original_token_count":14,"output":"cat: /tmp/goal-bg-output.log: No such file or directory\\n"}',
        ),
        tool(
          "exec-goal",
          "exec",
          { code: 'text(await tools.exec_command({cmd:"printf \'done\\\\n\' > goal-check.txt","workdir":"/tmp/canopy-stack/code"}));\ntext(await tools.update_goal({status:"complete"}));\n' },
          'Script completed\nWall time 0.1 seconds\nOutput:\n\n{"chunk_id":"22223a","wall_time_seconds":0.0000124,"exit_code":0,"original_token_count":11,"output":"/tmp/canopy-stack/code/goal-check.txt: verified\\n"}\n{"goal":{"threadId":"01a198fa-0935-77d1-9093-8d243c72323b","objective":"Create the file goal-check.txt","status":"complete","tokenBudget":300000,"tokensUsed":1512,"timeUsedSeconds":3},"remainingTokens":298488}',
        ),
        tool("exec-sleep", "exec", { code: 'await tools.exec_command({cmd:"sleep 25",yield_time_ms:30000,max_output_tokens:100});\n' }, "Script completed\nWall time 25.0 seconds\nOutput:\n"),
        tool("patch", "apply_patch", { input: "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-const a = 1;\n+const a = 2;\n*** Add File: docs/notes.md\n+# Notes\n+First line.\n*** End Patch" }, "Done!"),
        tool("plan", "update_plan", { explanation: "Splitting the work in three.", plan: [{ step: "Inspect transcripts", status: "completed" }, { step: "Registry", status: "in_progress" }, { step: "Verify", status: "pending" }] }, "Plan updated"),
      ],
    },
    {
      title: "Agent bus",
      items: [
        bus(
          "read-thread",
          "read_thread",
          { thread_id: OTHER, limit: 10 },
          {
            entries: [
              { seq: 3, type: "user_message", userMessage: { text: "Hej", clientId: "01a198ce-fe6d-77c3-b110-8d25414fb489", authorUserId: "01a1981a-c5b8-734c-a479-d714b09c22ae" } },
              { seq: 9, type: "agent_message", agentMessage: { text: "Hej! What can I help you with today?" } },
              { seq: 12, type: "user_message", userMessage: { text: "szybko odpisujesz" } },
              { seq: 20, type: "command_execution", commandExecution: { command: "ls -A /tmp/canopy-stack/code" } },
              { seq: 31, type: "agent_message", agentMessage: { text: "Dzięki! W czym mogę pomóc? Widzę, że jesteś w repozytorium `/tmp/canopy-stack/code`." } },
            ],
            nextSeq: 31,
          },
          { target: OTHER },
        ),
        bus("spawn", "spawn_thread", { title: "Lister", prompt: "Run `ls -A` in the current directory and report the file names it prints. Do not modify anything.", permission_mode: "read_only" }, { thread_id: SIDE, turn_id: "01a19868-b268-769b-8120-adea076eab3a", model: "", effort: "", permission_mode: "read_only", note: "The side thread is working." }),
        bus("send", "send_message", { thread_id: SIDE, prompt: "Also count the **hidden** files.", delivery: "steer" }, { thread_id: SIDE, turn_id: "x", delivery: "steer", note: "The message joins the turn that is running now." }, { target: SIDE }),
        bus("wait", "wait_threads", { thread_ids: [SIDE, OTHER], until: "all", timeout_seconds: 120 }, { done: true, threads: [summary("Lister", "idle", "There are 4 entries: demo, goal-check.txt, .git, README.md."), summary("Hej", "failed", "", { last_turn: { turn_id: "t", status: "failed", reason: "rate limited" } })] }),
        bus("get", "get_thread", { thread_id: SIDE }, summary("Lister", "running", "", { waiting_for_user: 1, queued_turns: 2 }), { target: SIDE }),
        bus("list", "list_threads", { scope: "children" }, { threads: [summary("Lister", "idle", "4 entries.")] }),
        bus("agents", "list_agents", {}, { agents: [], note: "No agent catalog yet: spawn_thread starts a copy of you (same provider, model and settings)." }),
        bus("wakeup", "schedule_wakeup", { delay_seconds: 60, prompt: "Reply with the single word PING" }, { schedule_id: "01a19856-ff8e-7015-923e-0d6cb862d72a", thread_id: GALLERY_THREAD_ID, next_run_at: "2026-11-01T18:21:00.781Z" }),
        bus("recurring", "schedule_recurring", { cron: "0 9 * * 1-5", timezone: "Europe/Warsaw", prompt: "Check CI on main and summarise failures.", max_runs: 20 }, { schedule_id: "s", thread_id: GALLERY_THREAD_ID, next_run_at: "2026-11-03T08:00:00.000Z", cron: "0 9 * * 1-5", timezone: "Europe/Warsaw" }),
        bus("interactions", "list_interactions", {}, { interactions: [{ request_id: "01a19856-ff8e-7015-923e-0d6cb862d72b", thread_id: SIDE, kind: "permission", tool_name: "Bash", request: { command: "rm -rf node_modules", cwd: "/repo" } }] }),
        bus("answer", "answer_interaction", { request_id: "01a19856-ff8e-7015-923e-0d6cb862d72b", response: "deny", message: "Do not delete dependencies; run the tests instead." }, { request_id: "01a19856-ff8e-7015-923e-0d6cb862d72b", status: "declined" }),
        bus("interrupt", "interrupt_thread", { thread_id: SIDE }, { thread_id: SIDE, interrupted: true }, { target: SIDE }),
        bus("refused", "close_thread", { thread_id: OTHER }, { error: "close_thread: only threads you spawned can be closed" }, { isError: true, target: OTHER }),
      ],
    },
    {
      title: "Interactions and provider events",
      items: [
        item("perm", {
          case: "interactionPrompt",
          value: { requestId: "r", kind: InteractionKind.PERMISSION, toolName: "shell", requestJson: JSON.stringify({ command: "rm -rf build", cwd: "/repo", reason: "Clean the old build." }), responseJson: JSON.stringify({ allow: true }), outcome: "allowed" },
        }),
        item("question", {
          case: "interactionPrompt",
          value: {
            requestId: "q",
            kind: InteractionKind.QUESTION,
            toolName: "request_user_input",
            requestJson: JSON.stringify({ questions: [{ id: "env", header: "Target", question: "Which environment should I deploy to?", options: [{ label: "Staging" }, { label: "Production" }] }] }),
            responseJson: JSON.stringify({ answers: { env: { answers: ["Staging"] } } }),
            outcome: "answered",
          },
        }),
        item("provider", { case: "providerItem", value: { type: "enteredReviewMode", json: JSON.stringify({ type: "enteredReviewMode", id: "item_7f3a9c0d4e5b6a7f8091", review: "Review the changes on this branch", target: { type: "baseBranch", branch: "main" } }) } }),
      ],
    },
  ];
}

/** Threads the gallery's links name, so they show titles and live status. */
export function galleryThreads(): ui.Thread[] {
  return [
    create(ui.ThreadSchema, { id: SIDE, title: "Lister", status: "running" }),
    create(ui.ThreadSchema, { id: OTHER, title: "Hej", status: "idle" }),
    create(ui.ThreadSchema, { id: GALLERY_THREAD_ID, title: "Tool calls gallery", status: "idle" }),
  ];
}
