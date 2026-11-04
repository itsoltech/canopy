import { join } from "node:path";

/** ACP's full agent definition; an empty tools list alone selects the CLI's default core tools. */
export const textAgent = {
  name: "canopy-text-generation",
  description: "Generate plain text without tools",
  tools: [],
  injectDefaultTools: false,
  discoverSkills: false,
  inheritSkills: false,
  disallowedTools: [
    "run_terminal_cmd",
    "read_file",
    "search_replace",
    "list_dir",
    "grep",
    "kill_task",
    "todo_write",
    "get_task_output",
    "wait_tasks",
    "monitor",
    "search_tool",
    "use_tool",
    "update_goal",
    "scheduler_create",
    "scheduler_delete",
    "scheduler_list",
    "web_search",
    "web_fetch",
    "image_gen",
    "image_edit",
    "video_gen",
    "write",
    "enter_plan_mode",
    "exit_plan_mode",
    "ask_user_question",
    "task",
    "send_subagent_message",
    "lsp",
  ],
};

export function textOnlyConfig(env: NodeJS.ProcessEnv, home: string): string {
  env["HOME"] = home;
  env["USERPROFILE"] = home;
  env["CLAUDE_CONFIG_DIR"] = join(home, "claude");
  env["CODEX_HOME"] = join(home, "codex");

  for (const key of [
    "GROK_MEMORY",
    "GROK_BACKEND_SEARCH",
    "GROK_CLAUDE_AGENTS_ENABLED",
    "GROK_CLAUDE_HOOKS_ENABLED",
    "GROK_CLAUDE_RULES_ENABLED",
    "GROK_CLAUDE_SKILLS_ENABLED",
    "GROK_CURSOR_AGENTS_ENABLED",
    "GROK_CURSOR_HOOKS_ENABLED",
    "GROK_CURSOR_RULES_ENABLED",
    "GROK_CURSOR_SKILLS_ENABLED",
  ])
    env[key] = "0";

  const rules = ["bash", "read", "edit", "grep", "mcp", "webfetch", "websearch"]
    .map((tool) => `{ action = "deny", tool = "${tool}" }`)
    .join(", ");

  return `\n[permission]\nrules = [${rules}]\n\n[compat.codex]\nhooks = false\nskills = false\n`;
}
