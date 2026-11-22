import { Provider, type SandboxSupport } from "@canopy/contracts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProfileStatus } from "./profiles.ts";
import { CLAUDE_SANDBOX_VERSIONS, CODEX_SANDBOX_VERSION } from "./sandbox-versions.ts";

const namespaceChecks = new Map<string, boolean>();

function linuxSandboxProblem(provider: Provider): string | undefined {
  if (process.platform !== "linux") return "This worker has no verified command sandbox for custom profiles.";
  const executable = Bun.which("bwrap");

  if (!executable) return "Install Bubblewrap on this Linux or WSL2 worker to verify shell isolation.";

  if (provider === Provider.CLAUDE && !Bun.which("socat"))
    return "Install socat on this Linux or WSL2 worker so Claude can filter shell connections.";

  let working = namespaceChecks.get(executable);

  if (working === undefined) {
    working =
      Bun.spawnSync([executable, "--unshare-net", "--ro-bind", "/", "/", "--", "/bin/true"], {
        timeout: 2_000,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }).exitCode === 0;
    namespaceChecks.set(executable, working);
  }

  return working ? undefined : "Bubblewrap could not start an isolated network on this worker.";
}

/** Report support for custom shell policy, independently of whether the CLI can run normal threads. */
export function sandboxSupport(
  provider: Provider,
  status: ProfileStatus | undefined,
): Omit<SandboxSupport, "$typeName"> {
  let offline = false;
  let domains = false;
  let offlineReason = "This harness does not support custom sandbox profiles.";
  let domainsReason = offlineReason;

  if (provider === Provider.CLAUDE) {
    offlineReason =
      process.platform === "win32"
        ? "Claude can use custom sandbox profiles on Windows with a worker running inside WSL2."
        : linuxSandboxProblem(provider) ||
          "This worker has not verified the Claude command sandbox and its effective network policy.";
    domainsReason = offlineReason;

    if (process.platform === "linux" && status?.resolved?.kind === "cliproxyapi" && !linuxSandboxProblem(provider)) {
      if (CLAUDE_SANDBOX_VERSIONS.includes(status.version ?? "") && !status.resolved.runtime.launchArgs?.length) {
        offline = domains = true;
        offlineReason = domainsReason = "";
      } else {
        offlineReason = domainsReason = "This Claude CLI version or custom launch configuration has not been verified.";
      }
    } else if (process.platform === "linux" && status?.resolved?.kind === "native" && !linuxSandboxProblem(provider)) {
      offlineReason = domainsReason =
        "Canopy cannot verify Claude server-managed policy for this instance. Choose a custom API instance.";
    }
  }

  if (provider === Provider.CODEX) {
    offlineReason =
      process.platform === "win32"
        ? "This worker has not verified offline command isolation with its native Windows Codex sandbox backend."
        : linuxSandboxProblem(provider) ||
          "This worker has not verified the Codex command sandbox and its effective execution rules.";
    domainsReason =
      process.platform === "win32"
        ? "The default native Windows Codex sandbox cannot enforce a filtered proxy. A worker inside WSL2 uses the Linux sandbox."
        : "This worker has not verified that Codex can enforce the profile's exact domain list.";

    if (process.platform === "linux" && status?.resolved?.kind === "cliproxyapi" && !linuxSandboxProblem(provider)) {
      if (status.loginHomePath && existsSync(join(status.loginHomePath, "auth.json"))) {
        offlineReason = "Choose a custom API instance without a linked Codex login to verify offline isolation.";
      } else if (status.version === CODEX_SANDBOX_VERSION && !status.resolved.runtime.launchArgs?.length) {
        offline = true;
        offlineReason = "";
      } else {
        offlineReason = `Use Codex ${CODEX_SANDBOX_VERSION} without custom launch arguments to verify this offline profile.`;
      }

      domainsReason =
        "Codex saved network rules can expand this list. Choose an offline profile or a verified Claude instance.";
    } else if (process.platform === "linux" && status?.resolved?.kind === "native" && !linuxSandboxProblem(provider)) {
      offlineReason =
        "Canopy cannot verify Codex server-managed policy for this instance. Choose a custom API instance.";
    }
  }

  if (status && !status.resolved) offlineReason = domainsReason = "This provider instance is unavailable.";

  return { offline, domains, offlineReason, domainsReason };
}
