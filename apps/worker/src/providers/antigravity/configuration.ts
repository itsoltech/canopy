import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PermissionMode } from "@canopy/contracts";
import type { antigravityProcessHome } from "./home.ts";

/** Include just rules from the intended workspace. Inheriting all project
 * customizations also starts project MCP servers and runs project hooks. */
function projectRules(cwd: string, scratch: boolean): string[] {
  const path = realpathSync(cwd);
  const dirs = [path];

  if (!scratch) {
    let dir = path;

    while (!existsSync(join(dir, ".git"))) {
      if (dirname(dir) === dir) {
        dirs.length = 1;
        break;
      }

      dir = dirname(dir);
      dirs.push(dir);
    }
  }

  const files = [
    "AGENTS.md",
    "GEMINI.md",
    ".agents/AGENTS.md",
    ".agents/GEMINI.md",
    ".agents/rules",
    ".agent/rules",
    ".agents/rules.json",
  ];

  return dirs.reverse().flatMap((dir) =>
    files.flatMap((file) => {
      const rule = join(dir, file);

      return existsSync(rule) ? [rule] : [];
    }),
  );
}

const managedTools = [
  "read_file",
  "write_file",
  "edit_file",
  "run_command",
  "search_web",
  "update_steps",
  "ask_question",
];

/** agy snapshots the selected agent in its conversation DB, including paths
 * to hooks. A restored session needs a stable path and the current decision. */
function permissionHook(dir: string): string {
  const path = join(dir, "hooks.json");
  const staged = join(dir, `hooks-${crypto.randomUUID()}.tmp`);

  const hook = (matcher: string, variable: string) => ({
    matcher,
    hooks: [
      {
        type: "command",
        command: process.platform === "win32" ? `echo %${variable}%` : `printf "%s\\n" "$${variable}"`,
      },
    ],
  });

  const gates = [
    hook(
      "^(run_command|send_command_input|write_file|write_to_file|edit_file|replace_file_content|multi_replace_file_content)$",
      "CANOPY_ANTIGRAVITY_TOOL_DECISION",
    ),
    // This implicit tool accepts kill and send_input but doesn't reliably request ACP approval.
    hook("^manage_task$", "CANOPY_ANTIGRAVITY_TASK_DECISION"),
  ];

  try {
    writeFileSync(staged, JSON.stringify({ canopy: { PreToolUse: gates } }), { mode: 0o600, flag: "wx" });
    renameSync(staged, path);
  } finally {
    rmSync(staged, { force: true });
  }

  return path;
}

export function writeAntigravityConfiguration(
  home: ReturnType<typeof antigravityProcessHome>,
  mode: PermissionMode,
  apiKey: boolean,
  cwd: string,
  scratch: boolean,
) {
  const fullAccess = mode === PermissionMode.FULL_ACCESS;
  const readOnly = mode === PermissionMode.READ_ONLY;

  const settings = {
    agentMode: "",
    toolPermission: fullAccess ? "always-proceed" : "request-review",
    allowNonWorkspaceAccess: fullAccess,
    ...(readOnly && { permissions: { deny: ["command(*)", "unsandboxed(*)", "write_file(*)"] } }),
    ...(apiKey && { modelProvider: "gemini" }),
  };

  writeFileSync(join(home.app, "settings.json"), JSON.stringify(settings), { mode: 0o600 });
  const agents = join(home.gemini, "config", "agents");
  mkdirSync(agents, { recursive: true, mode: 0o700 });
  const name = `canopy-${crypto.randomUUID()}`;

  const definition = [
    "---",
    `name: ${name}`,
    "description: Canopy thread",
    "mainAgent: true",
    "subagent: false",
    "inheritCustomizations: false",
    "inheritMcp: false",
    `tools: ${JSON.stringify(managedTools)}`,
    `rules: ${JSON.stringify(projectRules(cwd, scratch))}`,
    `hooks: ${JSON.stringify([permissionHook(home.policies)])}`,
    "---",
    "",
  ];

  writeFileSync(join(agents, `${name}.md`), definition.join("\n"), { mode: 0o600 });

  return {
    name,
    env: {
      CANOPY_ANTIGRAVITY_TOOL_DECISION: JSON.stringify({
        decision: fullAccess ? "allow" : readOnly ? "deny" : "force_ask",
      }),
      CANOPY_ANTIGRAVITY_TASK_DECISION: JSON.stringify({ decision: fullAccess ? "allow" : "deny" }),
    },
  };
}
