import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { GrokOptions } from "@canopy/grok-acp";
import type { ResolvedProfile } from "../profiles.ts";
import { instanceShadowHome } from "../../config/remote.ts";
import { instructionDirectory } from "../../agent-environment/files.ts";
import { textOnlyConfig } from "./text-agent.ts";
import { isolatedHomeEnvironment } from "../home.ts";

interface GrokLaunch {
  options: GrokOptions;
  cleanup(): void;
}

/** Hidden bots have no shell and must not discover any device context. */
function isolateBotEnv(env: NodeJS.ProcessEnv, home: string, webAccess = false): void {
  Object.assign(env, isolatedHomeEnvironment(home));

  for (const name of [
    "GROK_CLAUDE_AGENTS_ENABLED",
    "GROK_CURSOR_AGENTS_ENABLED",
    "GROK_PLUGINS_ENABLED",
    "GROK_MEMORY",
    "GROK_CLAUDE_HOOKS_ENABLED",
    "GROK_CURSOR_HOOKS_ENABLED",
    "GROK_CLAUDE_SKILLS_ENABLED",
    "GROK_CURSOR_SKILLS_ENABLED",
    "GROK_SUBAGENT_BUNDLE",
    "GROK_BACKEND_SEARCH",
    "GROK_WEB_FETCH",
    "GROK_SESSION_SEARCH",
    "GROK_ASK_USER_QUESTION",
    "GROK_AUTO_WAKE",
    "GROK_TITLE_REFRESH",
    "GROK_TURN_SUMMARY",
  ])
    env[name] = "0";

  env["GROK_DISABLE_EXPERIMENTS"] = "1";
  env["GROK_WEB_FETCH"] = webAccess ? "1" : "0";
  env["GROK_BACKEND_SEARCH"] = webAccess ? "1" : "0";
  env["GROK_WEB_FETCH_ALLOW_LOCAL"] = "0";
}

function botDeniedTools(webAccess = false): string {
  const denied = ["Bash(*)", "Read(*)", "Write(*)", "Edit(*)", "Agent(*)"];

  if (!webAccess) denied.push("WebFetch(*)", "WebSearch(*)");

  return `deny = ${JSON.stringify(denied)}\n\n[toolset.web_fetch]\nallow_local = false\n`;
}

function clearDeviceConfig(env: NodeJS.ProcessEnv): void {
  // Ignore device configuration: another account, endpoint, permissions or MCP servers.
  for (const key of [
    "GROK_CONFIG",
    "GROK_CONFIG_PATH",
    "GROK_AUTH",
    "GROK_AUTH_PATH",
    "GROK_AUTH_PROVIDER_COMMAND",
    "GROK_CLI_CHAT_PROXY_BASE_URL",
    "GROK_XAI_API_BASE_URL",
    "GROK_MODELS_BASE_URL",
    "GROK_MODELS_LIST_URL",
    "GROK_AGENT",
    "GROK_LOG_FILE",
  ])
    delete env[key];
}

/** Exclude global compatibility context while keeping the thread's shell environment. */
function instructionConfig(env: NodeJS.ProcessEnv, bot: boolean): string {
  if (!bot) {
    for (const name of [
      "GROK_CLAUDE_AGENTS_ENABLED",
      "GROK_CURSOR_AGENTS_ENABLED",
      "GROK_CLAUDE_RULES_ENABLED",
      "GROK_CURSOR_RULES_ENABLED",
      "GROK_CLAUDE_SKILLS_ENABLED",
      "GROK_CURSOR_SKILLS_ENABLED",
      "GROK_CODEX_SKILLS_ENABLED",
      "GROK_MEMORY",
    ])
      env[name] = "0";
  }

  // .agents is also a native Grok skill source, independent of Codex compatibility.
  const deviceHome = env["HOME"] || env["USERPROFILE"] || homedir();

  return `\n[compat.codex]\nskills = false\n\n[skills]\nignore = [${JSON.stringify(join(deviceHome, ".agents"))}]\n`;
}

/** Isolated configuration per process; durable sessions per instance. Keys never enter config or argv. */
export function grokLaunch(options: {
  dataDir: string;
  profile: ResolvedProfile;
  executable?: string | undefined;
  model?: string;
  effort?: string;
  readOnly?: boolean;
  fullAuto?: boolean;
  /** No sandbox at all (the user's explicit choice); otherwise as fullAuto. */
  fullAccess?: boolean;
  baseEnv?: NodeJS.ProcessEnv;
  linkDeviceLogin?: boolean;
  textOnly?: boolean;
  temporaryDir?: string;
  /** Hidden bot runtime: no device skills, user launch flags or local tools. */
  bot?: { cwd: string; instructions: string; sourceHome: string; webAccess?: boolean };
}): GrokLaunch {
  const { profile } = options;
  const runtime = profile.runtime ?? {};
  const root = options.temporaryDir ?? join(options.dataDir, "grok", profile.id);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const sessions = join(root, "sessions");

  if (!options.textOnly) mkdirSync(sessions, { recursive: true, mode: 0o700 });
  const home = mkdtempSync(join(root, "process-"));

  if (!options.textOnly) symlinkSync(sessions, join(home, "sessions"), "dir");

  const skillHome =
    instanceShadowHome(options.dataDir, "grok", profile.id, runtime) ?? join(options.dataDir, "grok-home");

  if (!options.bot && !options.textOnly) {
    const skills = join(skillHome, "skills");
    instructionDirectory(skills, true);
    // Bot processes never inherit reconciled instance skills.
    symlinkSync(skills, join(home, "skills"), process.platform === "win32" ? "junction" : "dir");
  }

  const env: NodeJS.ProcessEnv = { ...(options.baseEnv ?? process.env), ...profile.env };

  clearDeviceConfig(env);
  env["GROK_HOME"] = home;
  env["GROK_SUBAGENTS"] = "0";
  env["GROK_GOAL"] = "0";
  env["GROK_WORKFLOWS"] = "0";
  env["GROK_CLAUDE_MCPS_ENABLED"] = "0";
  env["GROK_CURSOR_MCPS_ENABLED"] = "0";
  env["GROK_MANAGED_MCPS_ENABLED"] = "0";
  env["GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED"] = "0";
  env["GROK_TELEMETRY_ENABLED"] = "0";
  env["GROK_TELEMETRY_TRACE_UPLOAD"] = "0";
  env["DISABLE_ERROR_REPORTING"] = "1";
  env["GROK_DEFAULT_SELECTED_PERMISSION"] = "reject";
  env["RUST_LOG"] = "off";

  if (options.bot) isolateBotEnv(env, home, options.bot.webAccess);

  if (options.readOnly) env["GROK_SANDBOX"] = "read-only";
  else if (options.fullAccess) env["GROK_SANDBOX"] = "off";
  else if (options.fullAuto) env["GROK_SANDBOX"] = "workspace";
  else delete env["GROK_SANDBOX"];

  let config =
    '[cli]\nauto_update = false\nuse_leader = false\n\n[shell_environment_policy]\nexclude = ["CANOPY_GROK_API_KEY", "XAI_API_KEY", "GROK_CODE_XAI_API_KEY"]\n';

  config += '\n[ui]\npermission_mode = "ask"\nremember_tool_approvals = false\n';

  // This server only forwards calls to the gateway, which enforces approvals and connector grants.
  // Native tools and all other MCP servers keep their existing permission checks.
  if (!options.textOnly)
    config += options.bot?.webAccess
      ? '\n[permission]\nallow = ["MCPTool(canopy__*)", "WebSearch(*)", "WebFetch(*)"]\n'
      : '\n[permission]\nallow = ["MCPTool(canopy__*)"]\n';

  // Grok auto-allows mkdir/touch before asking ACP. Explicit denies also cover workspaces under /tmp.
  if (options.textOnly) config += textOnlyConfig(env, home);
  else if (options.readOnly && !options.bot)
    config += 'rules = [{ action = "deny", tool = "edit" }, { action = "deny", tool = "bash" }]\n';

  if (options.bot) config += botDeniedTools(options.bot.webAccess);

  if (!options.textOnly) config += instructionConfig(env, !!options.bot);

  if (profile.kind === "cliproxyapi") {
    delete env["XAI_API_KEY"];
    delete env["GROK_CODE_XAI_API_KEY"];
    env["CANOPY_GROK_API_KEY"] = profile.apiKey;
    // Also needed by the CLI's session authentication guard; per-model env_key chooses the same key.
    env["XAI_API_KEY"] = profile.apiKey;
    const base = profile.baseUrl.href.replace(/\/$/, "").replace(/\/v1$/, "") + "/v1";
    const model = options.model || "grok-4.6";
    config += `\n[model.${JSON.stringify(model)}]\nmodel = ${JSON.stringify(model)}\nbase_url = ${JSON.stringify(base)}\nenv_key = "CANOPY_GROK_API_KEY"\napi_backend = "chat_completions"\n`;
  } else if (options.linkDeviceLogin !== false || runtime.ownLogin) {
    const source =
      options.bot?.sourceHome ??
      (runtime.ownLogin
        ? runtime.shadowHomePath || join(options.dataDir, "homes", `grok-${profile.id}`)
        : runtime.homePath || (options.baseEnv ?? process.env)["GROK_HOME"] || join(homedir(), ".grok"));

    env["GROK_AUTH_PATH"] = join(source, "auth.json");
  }

  writeFileSync(join(home, "config.toml"), config, { mode: 0o600 });

  const agent = join(home, "bot.md");
  const botTools = options.bot?.webAccess ? "search_tool,use_tool,web_search,web_fetch" : "search_tool,use_tool";

  if (options.bot)
    writeFileSync(
      agent,
      `---\nname: canopy-bot\ndescription: Canopy conversational bot\ntools: ${botTools}\n---\n${options.bot.instructions}\n`,
      { mode: 0o600 },
    );

  const args = [
    ...(options.bot ? ["--tools", botTools] : []),
    "agent",
    "--no-leader",
    ...(options.model ? ["--model", options.model] : []),
    ...(options.effort ? ["--reasoning-effort", options.effort] : []),
    ...(options.bot ? ["--agent-profile", agent] : options.textOnly ? [] : (runtime.launchArgs ?? [])),
    "stdio",
  ];

  return {
    options: {
      executable: runtime.executablePath || options.executable || "grok",
      args,
      env,
      ...(options.bot && { cwd: options.bot.cwd }),
      secrets: [
        ...(profile.kind === "cliproxyapi" ? [profile.apiKey, profile.baseUrl.href, profile.baseUrl.host] : []),
        ...Object.values(profile.env),
      ],
    },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}
