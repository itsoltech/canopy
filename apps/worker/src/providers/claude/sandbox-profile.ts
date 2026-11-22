import {
  resolveSettings,
  type Options,
  type Query,
  type ResolvedSettings,
  type SandboxSettings,
  type Settings,
} from "@anthropic-ai/claude-agent-sdk";
import { PermissionMode, type SandboxProfile, type SandboxProfileBinding } from "@canopy/contracts";
import { sandboxBinding } from "@canopy/domain/sandbox-profiles";
import { runProcess } from "@canopy/process-governor";
import { isAbsolute } from "node:path";
import { repoRoot } from "../../git/refs.ts";
import { CLAUDE_SANDBOX_VERSIONS } from "../sandbox-versions.ts";
import type { claudeRuntime } from "./session-runtime.ts";
import type { ClaudeInstanceRuntime } from "./thread-types.ts";

export function claudeSandboxProfile(
  binding: SandboxProfileBinding | undefined,
  mode: PermissionMode,
  platform = process.platform,
): { readonly digest: string; readonly profile: SandboxProfile } | undefined {
  if (!binding) return;

  if (mode !== PermissionMode.FULL_AUTO) throw new Error("Choose Sandbox mode to use a custom Claude profile.");

  if (platform !== "linux" && platform !== "darwin")
    throw new Error("Claude Sandbox profiles require a Linux or macOS worker. On Windows, use a worker in WSL2.");

  if (!binding.profile) throw new Error("The Claude Sandbox profile has no policy.");
  const canonical = sandboxBinding(binding.profile);

  if (!canonical.profile || canonical.digest !== binding.digest)
    throw new Error("The Claude Sandbox profile does not match its immutable snapshot.");

  return { digest: canonical.digest, profile: canonical.profile };
}

export function claudeProfileSandbox(allowedDomains: string[]): SandboxSettings {
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    excludedCommands: [],
    enableWeakerNestedSandbox: false,
    allowNestedUserNamespaces: false,
    enableWeakerNetworkIsolation: false,
    allowAppleEvents: false,
    network: {
      strictAllowlist: true,
      allowedDomains: [...allowedDomains],
      allowAllUnixSockets: false,
      allowLocalBinding: false,
    },
  };
}

/** The inspection uses the worker's machine policy and the actual query's config home. */
export function checkClaudeSandboxPolicy(settings: Settings, allowedDomains: readonly string[]): void {
  if (settings.policyHelper || settings["policyHelpers"] || settings.forceRemoteSettingsRefresh)
    throw new Error("Canopy cannot verify dynamically supplied Claude administrator settings.");

  if (
    Object.keys(settings.env ?? {}).length ||
    Object.keys(settings.hooks ?? {}).length ||
    Object.keys(settings.enabledPlugins ?? {}).length
  )
    throw new Error("Claude administrator environment, hooks, or plugins are incompatible with this Sandbox profile.");

  if (settings.permissions?.ask?.length)
    throw new Error("Claude administrator rules require approvals that cannot be applied with this Sandbox profile.");

  const sandbox = settings.sandbox;
  const network = sandbox?.network;

  if (
    sandbox?.enabled === false ||
    sandbox?.failIfUnavailable === false ||
    sandbox?.allowUnsandboxedCommands === true ||
    sandbox?.autoAllowBashIfSandboxed === false ||
    sandbox?.excludedCommands?.length ||
    sandbox?.enableWeakerNestedSandbox ||
    sandbox?.allowNestedUserNamespaces ||
    sandbox?.enableWeakerNetworkIsolation ||
    sandbox?.allowAppleEvents ||
    sandbox?.filesystem?.disabled ||
    sandbox?.bwrapPath ||
    sandbox?.socatPath ||
    sandbox?.ripgrep
  )
    throw new Error("Claude administrator sandbox settings are incompatible with this Sandbox profile.");

  if (
    network?.httpProxyPort !== undefined ||
    network?.socksProxyPort !== undefined ||
    network?.tlsTerminate ||
    network?.allowAllUnixSockets ||
    network?.allowUnixSockets?.length ||
    network?.allowMachLookup?.length ||
    network?.allowLocalBinding ||
    network?.allowManagedDomainsOnly ||
    network?.allowedDomains?.some((domain) => !allowedDomains.includes(domain)) ||
    settings.permissions?.allow?.some((rule) => /^WebFetch\s*\(/u.test(rule))
  )
    throw new Error("Claude administrator network settings are incompatible with this exact domain list.");
}

/** Relative deny rules and hook decisions belong to their original source and cannot be moved to --settings. */
function checkSkippedClaudeSettings(sources: ResolvedSettings["sources"]): void {
  for (const { source, settings } of sources) {
    if (source === "managed" || source === "flag") continue;

    const permissions = settings.permissions;
    const sandbox = settings.sandbox;

    if (
      permissions?.deny?.length ||
      permissions?.ask?.length ||
      permissions?.defaultMode === "dontAsk" ||
      permissions?.defaultMode === "plan" ||
      permissions?.blockReadsOutsideWorkingDirectories ||
      permissions?.blockWritesOutsideWorkingDirectories ||
      sandbox?.autoAllowBashIfSandboxed === false ||
      sandbox?.network?.deniedDomains?.length ||
      sandbox?.network?.strictAllowlist ||
      sandbox?.filesystem?.denyRead?.length ||
      sandbox?.filesystem?.denyWrite?.length ||
      Object.keys(sandbox?.credentials ?? {}).length ||
      settings.deniedMcpServers?.length ||
      Object.values(settings.enabledPlugins ?? {}).some(Boolean) ||
      Object.keys(settings.hooks ?? {}).length
    )
      throw new Error(`Claude ${source} settings contain restrictions that this Sandbox profile cannot preserve.`);
  }
}

const unsafeEnvironment =
  /^(?:CLAUDE_CODE_(?:.*(?:SANDBOX|SETTINGS|POLICY).*|SHELL(?:_|$)|REMOTE(?:_|$)|EVAL(?:_|$)|SIMPLE$|SAFE_MODE$)|(?:BASH_ENV|ENV|NODE_OPTIONS|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*)$)/u;

export function claudeSandboxEnvironment(env: Options["env"]): NonNullable<Options["env"]> {
  if (Object.entries(env ?? {}).some(([name, value]) => value && unsafeEnvironment.test(name)))
    throw new Error("This Claude instance has environment overrides that prevent verifying its Sandbox profile.");

  const endpoint = env?.["ANTHROPIC_BASE_URL"];

  // The SDK resolver does not inspect fresh server-managed settings. First-party sign-in or API access can
  // introduce an uninspected policy after startup; a custom endpoint without OAuth uses machine policy.
  if (
    !endpoint ||
    !URL.canParse(endpoint) ||
    new URL(endpoint).hostname.toLowerCase().replace(/\.$/u, "").endsWith("anthropic.com") ||
    env?.["CLAUDE_CODE_OAUTH_TOKEN"] ||
    env?.["CLAUDE_CODE_USE_BEDROCK"] ||
    env?.["CLAUDE_CODE_USE_VERTEX"] ||
    env?.["CLAUDE_CODE_USE_FOUNDRY"] ||
    !(env?.["ANTHROPIC_API_KEY"] || env?.["ANTHROPIC_AUTH_TOKEN"])
  )
    throw new Error(
      "Canopy cannot verify Claude server-managed sandbox settings. Use an instance with a custom API endpoint.",
    );

  return {
    ...env,
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    CLAUDE_CODE_DISABLE_PROACTIVITY: "1",
    CLAUDE_CODE_STARTUP_FAILURE_RESULTS: "1",
  };
}

const versionProblem = `Use one of the verified Claude Code versions for Sandbox profiles (${CLAUDE_SANDBOX_VERSIONS.join(", ")}).`;

export async function preflightClaudeSandbox(
  launch: Options,
  runtime: ClaudeInstanceRuntime,
  allowedDomains: readonly string[],
  inHome: ReturnType<typeof claudeRuntime>["inHome"],
): Promise<string> {
  const { cwd, env, pathToClaudeCodeExecutable: executable } = launch;

  if (!cwd || !env || !executable || !isAbsolute(executable)) throw new Error(versionProblem);

  if (Object.keys(runtime.extraArgs ?? {}).length)
    throw new Error("Canopy cannot preserve the restrictions from this Claude instance's extra launch arguments.");

  await checkClaudeSettingsSources(cwd, runtime, allowedDomains, inHome);

  const version = await runProcess(
    { argv: [executable, "--version"], cwd, env, timeoutMs: 5_000, maxBytes: 4096 },
    { kind: "probe" },
  )
    .then((result) =>
      result.code === 0 ? /^(\d+\.\d+\.\d+) \(Claude Code\)$/u.exec(result.stdout.trim())?.[1] : undefined,
    )
    .catch(() => undefined);

  if (!version || !CLAUDE_SANDBOX_VERSIONS.includes(version)) throw new Error(versionProblem);

  return version;
}

async function checkClaudeSettingsSources(
  cwd: string,
  { home, sourceHome }: ClaudeInstanceRuntime,
  allowedDomains: readonly string[],
  inHome: ReturnType<typeof claudeRuntime>["inHome"],
) {
  const root = await repoRoot(cwd);

  const sources = await inHome(home, async () => {
    const workspace = await resolveSettings({ cwd, settingSources: ["user", "project", "local"] });

    const rootSettings =
      root && root !== cwd ? await resolveSettings({ cwd: root, settingSources: ["project", "local"] }) : undefined;

    return [...workspace.sources, ...(rootSettings?.sources ?? [])];
  }).catch(() => {
    throw new Error("Canopy could not read Claude settings for this Sandbox profile.");
  });

  for (const { source, settings } of sources) {
    if (source === "managed") checkClaudeSandboxPolicy(settings, allowedDomains);
  }

  checkSkippedClaudeSettings(sources);

  if (sourceHome && sourceHome !== home) {
    const user = await inHome(sourceHome, () => resolveSettings({ cwd, settingSources: ["user"] })).catch(() => {
      throw new Error("Canopy could not read the selected Claude user settings for this Sandbox profile.");
    });

    checkSkippedClaudeSettings(user.sources);
  }
}

export async function checkClaudeSandboxStartup(query: Query, version: string, abort?: AbortController) {
  const timer = setTimeout(() => abort?.abort(), 15_000);

  try {
    const initialized = await query.initializationResult().catch((error: Error) => {
      if (/sandbox required but unavailable/iu.test(error.message))
        throw new Error(
          "Claude's required command sandbox is unavailable. Check the worker's sandbox dependencies and OS permissions.",
        );
      throw new Error("Canopy could not initialize Claude with the required Sandbox profile.");
    });

    if (initialized.claude_code_version !== version)
      throw new Error("Canopy could not verify the Claude Code version running this Sandbox profile.");
  } finally {
    clearTimeout(timer);
  }
}
