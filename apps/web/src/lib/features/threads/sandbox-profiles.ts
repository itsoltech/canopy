import { type Provider, type SandboxProfile, type ui } from "@canopy/contracts";
import type { SelectOption } from "#lib/shared/ui/listbox.ts";

export const sandboxProfilesSettingsHref = "/settings/threads#sandbox-profiles";
export const nativeWindowsSandboxMode = "Claude needs a worker running inside WSL2 to use Sandbox on Windows.";
export const linkedSandboxSelection = "Open Canopy on the linked computer to choose a sandbox profile.";

export const sandboxShellUnavailable =
  "Shell commands are unavailable with a sandbox profile. Remove ! to use plain text.";

export const defaultSandboxProfile: SelectOption = {
  value: "",
  label: "Harness default",
  description: "Uses the agent’s standard sandbox.",
};

export function sandboxProfileProblem(
  { worker, provider, profileId }: { worker: ui.Worker | undefined; provider: Provider | undefined; profileId: string },
  profile: SandboxProfile,
): string | undefined {
  if (!worker || !provider) return "Choose a worker and agent to check sandbox support.";

  if (!worker.online) return "The worker is offline.";

  if (worker.configVersion !== worker.appliedVersion)
    return "Wait for the worker to report sandbox support for its current settings.";

  const report = worker.profiles.find(
    (entry) => entry.id === (profileId || "native") && entry.providers.includes(provider),
  );

  if (report && !report.available) return report.detail || "The selected agent instance is unavailable.";

  const support = report?.sandboxSupport;

  if (!support)
    return worker.os === "win32"
      ? "This native Windows worker has not reported custom sandbox support. Check a worker running inside WSL2."
      : "The selected agent instance has not reported custom sandbox support.";

  return profile.allowedDomains.length
    ? support.domains
      ? undefined
      : support.domainsReason || "The selected agent cannot restrict commands to the listed domains."
    : support.offline
      ? undefined
      : support.offlineReason || "The selected agent cannot run commands offline in its sandbox.";
}

export function threadSandboxRefusal(thread: ui.Thread | undefined, worker: ui.Worker | undefined): string | undefined {
  const binding = thread?.sandboxProfile;

  if (!thread || !binding) return undefined;

  const problem = binding.profile
    ? sandboxProfileProblem({ worker, provider: thread.provider, profileId: thread.providerProfileId }, binding.profile)
    : "Canopy could not read the saved sandbox profile.";

  return problem ? `${problem} Choose another profile in thread permissions.` : undefined;
}

export function sandboxProfileOption(profile: SandboxProfile, problem: string | undefined): SelectOption {
  const count = profile.allowedDomains.length;

  return {
    value: profile.id,
    label: profile.name,
    description: problem ?? (count === 0 ? "Offline" : `${count} ${count === 1 ? "domain" : "domains"}`),
    disabled: Boolean(problem),
  };
}

export function sandboxProfileGroups(options: readonly SelectOption[]) {
  const available: SelectOption[] = [];
  const unavailable = new Map<string, SelectOption[]>();

  for (const option of options) {
    if (!option.disabled) {
      available.push(option);
      continue;
    }

    const reason = option.description || "This profile is unavailable on the selected worker.";
    const group = unavailable.get(reason);

    if (group) group.push(option);
    else unavailable.set(reason, [option]);
  }

  return { available, unavailable: [...unavailable] };
}
