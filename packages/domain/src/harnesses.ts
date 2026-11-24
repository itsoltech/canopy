import { PermissionMode, Provider } from "@canopy/contracts";

export const HARNESSES = ["claude", "codex", "grok", "antigravity"] as const;

export type Harness = (typeof HARNESSES)[number];

const providers: Record<Harness, Provider> = {
  claude: Provider.CLAUDE,
  codex: Provider.CODEX,
  grok: Provider.GROK,
  antigravity: Provider.ANTIGRAVITY,
};

export const HARNESS_NAMES: Record<Harness, string> = {
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
  antigravity: "Antigravity",
};

const byProvider = new Map(HARNESSES.map((harness) => [providers[harness], harness]));

export const isHarness = (name: string): name is Harness => Object.hasOwn(providers, name);
export const harnessOf = (provider: Provider): Harness | undefined => byProvider.get(provider);

export const providerOf = (name: string | null | undefined): Provider =>
  name && isHarness(name) ? providers[name] : Provider.UNSPECIFIED;

export function harnessName(provider: Provider): string {
  const harness = harnessOf(provider);

  return harness ? HARNESS_NAMES[harness] : "Unknown provider";
}

/** Providers with a tool-isolated runtime for bot turns and background text generation. */
export const supportsIsolatedRuns = (provider: Provider): boolean =>
  provider === Provider.CLAUDE || provider === Provider.CODEX || provider === Provider.GROK;

export const ANTIGRAVITY_PERMISSION_GUIDANCE = "Choose Ask, Read only, Accept edits, or Full access for Antigravity.";

const antigravityPermissions = new Set([
  PermissionMode.UNSPECIFIED,
  PermissionMode.ASK,
  PermissionMode.READ_ONLY,
  PermissionMode.ACCEPT_EDITS,
  PermissionMode.FULL_ACCESS,
]);

export const supportsThreadPermission = (provider: Provider, mode: PermissionMode): boolean =>
  provider !== Provider.ANTIGRAVITY || antigravityPermissions.has(mode);

export const supportsNativeGoals = (provider: Provider): boolean =>
  provider === Provider.CLAUDE || provider === Provider.CODEX;

export const supportsSessionFork = (provider: Provider): boolean =>
  provider === Provider.CLAUDE || provider === Provider.CODEX;

export function sessionForkProblem(harness: string): string | undefined {
  const provider = providerOf(harness);

  return supportsSessionFork(provider) ? undefined : `${harnessName(provider)} does not support session forks.`;
}
