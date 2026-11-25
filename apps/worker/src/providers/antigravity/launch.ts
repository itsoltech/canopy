import { homedir } from "node:os";
import { join } from "node:path";
import type { AcpOptions, ToolCall } from "@canopy/acp";
import { PermissionMode } from "@canopy/contracts";
import type { ResolvedProfile } from "../profiles.ts";
import { antigravityAuth } from "./auth.ts";
import { writeAntigravityConfiguration } from "./configuration.ts";
import { antigravityGeminiKey } from "./gemini-key.ts";
import { antigravityProcessHome, checkAntigravityScratch } from "./home.ts";
import { antigravitySkillRead } from "./skill-reads.ts";

export interface AntigravityInstance {
  dataDir: string;
  profile: ResolvedProfile;
  executable: string;
  linkDeviceLogin: boolean;
  deviceHome?: string | undefined;
  baseEnv?: NodeJS.ProcessEnv;
}

interface LaunchOptions extends AntigravityInstance {
  cwd: string;
  permissionMode: PermissionMode;
  /** Absent during disposable probes. */
  threadId?: string;
  scratch?: boolean;
}

/** These releases support the tested ACP HTTP transport and custom-agent isolation controls. */
export function supportsAntigravityVersion(version: string | undefined): boolean {
  const match = /^1\.(\d+)\.(\d+)$/.exec(version ?? "");

  return Boolean(match && (Number(match[1]) > 5 || (Number(match[1]) === 5 && Number(match[2]) >= 16)));
}

/** Preserve the thread shell's HOME and XDG. The CLI receives a private --gemini-dir. */
export function antigravityLaunch(options: LaunchOptions) {
  const { profile, cwd, permissionMode } = options;

  if (profile.kind !== "native") throw new Error("Antigravity requires a native provider instance.");

  if (profile.runtime.ownLogin || profile.runtime.homePath || profile.runtime.launchArgs?.length)
    throw new Error("Antigravity cannot use a separate login source or extra launch arguments.");

  if (permissionMode === PermissionMode.FULL_AUTO)
    throw new Error("Antigravity cannot guarantee the Canopy workspace sandbox on this runtime.");

  if (options.scratch) checkAntigravityScratch(cwd);
  const device = options.baseEnv ?? process.env;
  const env: NodeJS.ProcessEnv = { ...device, ...profile.env };
  const auth = antigravityAuth(profile.env, device, options.linkDeviceLogin);

  if (auth.kind === "unavailable") throw new Error(auth.problem);

  // The CLI has environment overrides for storage, injected agents, gateways
  // and credentials. Native OAuth and explicit Gemini API auth are the only
  // supported routes, alongside the unmodified OS keyring environment.
  for (const key of Object.keys(env)) {
    if (/^(?:AGY_|ANTIGRAVITY_|GEMINI_API_KEY$|GOOGLE_GEMINI_BASE_URL$|GOOGLE_API_KEY$)/i.test(key)) delete env[key];
  }

  env["AGY_CLI_DISABLE_AUTO_UPDATE"] = "true";

  const home = antigravityProcessHome({
    dataDir: options.dataDir,
    profile,
    deviceHome:
      options.deviceHome ?? join(device["HOME"] || device["USERPROFILE"] || homedir(), ".gemini", "antigravity-cli"),
    linkLogin: auth.kind === "device",
    ...(options.threadId !== undefined && { threadId: options.threadId }),
  });

  let route: ReturnType<typeof antigravityGeminiKey> | undefined;

  const cleanup = () => {
    try {
      return route?.close();
    } finally {
      home.cleanup();
    }
  };

  try {
    const configuration = writeAntigravityConfiguration(
      home,
      permissionMode,
      auth.kind === "key",
      cwd,
      options.scratch === true,
    );

    Object.assign(env, configuration.env);

    if (auth.kind === "key") {
      route = antigravityGeminiKey(auth.apiKey, auth.baseUrl);
      Object.assign(env, route.env);
    }

    const launch: AcpOptions = {
      agentName: "Antigravity",
      executable: profile.runtime.executablePath || options.executable || "agy",
      args: [
        "acp",
        "--process-per-session",
        "--disable-telemetry",
        "--include-default-customizations=false",
        "--gemini-dir",
        home.gemini,
        "--agent",
        configuration.name,
        ...(permissionMode === PermissionMode.FULL_ACCESS ? ["--dangerously-skip-permissions"] : []),
      ],
      cwd,
      env,
      secrets: [
        ...Object.values(profile.env),
        ...(route ? [route.env.GEMINI_API_KEY, route.env.GOOGLE_GEMINI_BASE_URL] : []),
      ],
    };

    return {
      options: launch,
      allowSkillRead: (tool: ToolCall) => antigravitySkillRead(home.skills, join(home.app, "skills"), tool),
      cleanup,
    };
  } catch (error) {
    void cleanup()?.catch(() => {});
    throw error;
  }
}
