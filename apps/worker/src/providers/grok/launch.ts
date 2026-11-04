import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { GrokOptions } from "@canopy/grok-acp";
import type { ResolvedProfile } from "../profiles.ts";
import { instanceShadowHome } from "../../config/remote.ts";
import { instructionDirectory } from "../../agent-environment/files.ts";
import { textOnlyConfig } from "./text-agent.ts";

interface GrokLaunch {
  options: GrokOptions;
  cleanup(): void;
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
  baseEnv?: NodeJS.ProcessEnv;
  linkDeviceLogin?: boolean;
  textOnly?: boolean;
  temporaryDir?: string;
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

  const skills = join(skillHome, "skills");

  if (!options.textOnly) instructionDirectory(skills, true);

  // The process home is disposable. Skills remain in the reconciled, durable instance home.
  if (!options.textOnly) symlinkSync(skills, join(home, "skills"), process.platform === "win32" ? "junction" : "dir");
  const env: NodeJS.ProcessEnv = { ...(options.baseEnv ?? process.env), ...profile.env };

  // Ignore device configuration: it can carry another account, endpoint, permissions or MCP servers.
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

  if (options.readOnly) env["GROK_SANDBOX"] = "read-only";
  else if (options.fullAuto) env["GROK_SANDBOX"] = "workspace";
  else delete env["GROK_SANDBOX"];

  let config =
    '[cli]\nauto_update = false\nuse_leader = false\n\n[shell_environment_policy]\nexclude = ["CANOPY_GROK_API_KEY", "XAI_API_KEY", "GROK_CODE_XAI_API_KEY"]\n';

  config += '\n[ui]\npermission_mode = "ask"\nremember_tool_approvals = false\n';

  // Grok auto-allows mkdir/touch before asking ACP. Explicit denies also cover workspaces under /tmp.
  if (options.textOnly) config += textOnlyConfig(env, home);
  else if (options.readOnly)
    config += '\n[permission]\nrules = [{ action = "deny", tool = "edit" }, { action = "deny", tool = "bash" }]\n';

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
    const source = runtime.ownLogin
      ? runtime.shadowHomePath || join(options.dataDir, "homes", `grok-${profile.id}`)
      : runtime.homePath || (options.baseEnv ?? process.env)["GROK_HOME"] || join(homedir(), ".grok");

    env["GROK_AUTH_PATH"] = join(source, "auth.json");
  }

  writeFileSync(join(home, "config.toml"), config, { mode: 0o600 });

  const args = [
    "agent",
    "--no-leader",
    ...(options.model ? ["--model", options.model] : []),
    ...(options.effort ? ["--reasoning-effort", options.effort] : []),
    ...(options.textOnly ? [] : (runtime.launchArgs ?? [])),
    "stdio",
  ];

  return {
    options: {
      executable: runtime.executablePath || options.executable || "grok",
      args,
      env,
      secrets: [
        ...(profile.kind === "cliproxyapi" ? [profile.apiKey, profile.baseUrl.href, profile.baseUrl.host] : []),
        ...Object.values(profile.env),
      ],
    },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}
