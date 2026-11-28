import {
  Provider,
  ProviderConfigurationMode,
  ProviderProfileKind,
  type ProviderAccountStatus,
  type ui,
} from "@canopy/contracts";
import type { Tone } from "./status-look.ts";
import { codexLoginProblem } from "./codex-login-problems.ts";
import { harnessName } from "./harnesses.ts";

export { harnessName } from "./harnesses.ts";

/**
 * How a provider instance reads in Settings → Providers on every client (web: InstanceRow/InstanceDetail, mobile:
 * ProviderSettings). Pure text and tones; no requests.
 */

/** Default for a native Codex instance using the device login. */
export const defaultCodexHomeMode = (id: string): ProviderConfigurationMode =>
  id === "native" ? ProviderConfigurationMode.SHARED : ProviderConfigurationMode.ISOLATED;

export const codexHomeModes = [
  {
    value: "isolated",
    label: "Isolated",
    mode: ProviderConfigurationMode.ISOLATED,
    description: "Use Canopy’s private home to continue imported copies of threads.",
  },
  {
    value: "shared",
    label: "Use CLI home",
    mode: ProviderConfigurationMode.SHARED,
    description: "Use the terminal login and its settings, including MCP servers and hooks.",
  },
] as const;

export const codexHomeDescription = "Codex saves new thread files in the selected home.";

/** The label, else the harness's name for the built-in device login ("Codex", "Claude"), else the id. */
export const instanceName = (instance: Pick<ui.ProviderInstance, "label" | "id" | "builtIn" | "harness">): string =>
  instance.label || (instance.builtIn ? harnessName(instance.harness) : instance.id);

export const kindLabel = (kind: ProviderProfileKind | undefined): string =>
  kind === ProviderProfileKind.CLIPROXYAPI
    ? "Proxy"
    : kind === ProviderProfileKind.NATIVE
      ? "Device login"
      : "Connection unknown";

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// ------------------------------------------------------------------ status

export interface InstanceStatus {
  readonly label: string;
  readonly tone: Tone;
}

function loginUnavailable(on: ui.InstanceOnWorker): boolean {
  return on.account?.state === "error" && !!codexLoginProblem(on.account.detail);
}

function signInStatus(on: ui.InstanceOnWorker): InstanceStatus | undefined {
  if (on.account?.state === "expired") return { label: "Sign-in expired", tone: "amber" };

  if (on.account?.state === "signed_out") return { label: "Not signed in", tone: "amber" };
}

/** One line for an instance on a worker, as the list and the detail show it (e.g. "Authenticated · ChatGPT"). */
export function statusOn(on: ui.InstanceOnWorker | undefined, online: boolean): InstanceStatus {
  if (!on) return { label: "Unknown worker", tone: "neutral" };

  if (!on.enabled) return { label: "Turned off", tone: "neutral" };

  if (!on.reported)
    return {
      label: on.detail || (online ? "Waiting for the worker" : "Applies when the worker connects"),
      tone: "neutral",
    };

  const signIn = signInStatus(on);

  if (on.available && signIn) return signIn;

  if (loginUnavailable(on)) return { label: "Login unavailable", tone: "amber" };

  if (on.account?.state === "stored") return { label: "Login saved", tone: "neutral" };

  if (on.available)
    return { label: on.authenticated && on.auth ? `Authenticated · ${on.auth}` : "Available", tone: "emerald" };
  const detail = on.detail.toLowerCase();

  if (detail.includes("not found") || detail.includes("not runnable")) return { label: "Not installed", tone: "rose" };

  if (detail.includes("api_key")) return { label: "Missing key", tone: "amber" };

  if (detail.includes("not signed in") || detail.includes("login")) return { label: "Not signed in", tone: "amber" };

  if (detail === "disabled") return { label: "Turned off", tone: "neutral" };

  return { label: capitalize(on.detail || "Unavailable"), tone: "rose" };
}

/** In "All workers": how many workers run it, and how many of those report it usable. */
export function statusAcross(instance: ui.ProviderInstance): InstanceStatus {
  const enabled = instance.workers.filter((w) => w.enabled);

  if (enabled.length === 0) return { label: "Not on any worker", tone: "neutral" };
  const usable = enabled.filter((w) => w.available && !signInStatus(w) && !loginUnavailable(w)).length;
  const of = `${enabled.length} worker${enabled.length === 1 ? "" : "s"}`;

  if (usable === enabled.length) return { label: `Ready on ${of}`, tone: "emerald" };

  return { label: `${usable}/${enabled.length} workers ready`, tone: usable === 0 ? "rose" : "amber" };
}

/** Versions reported for the instance ("v0.166.0", several when workers differ). */
export function versionsOf(instance: ui.ProviderInstance, workerId: string | undefined): string {
  const versions = new Set(
    instance.workers.filter((w) => (workerId ? w.workerId === workerId : w.enabled) && w.version).map((w) => w.version),
  );

  return [...versions].map((v) => `v${v}`).join(", ");
}

/** False when the harness has nothing to say about the account (Grok, a missing CLI): the row stays empty. */
export const hasAccountStatus = (
  account: ProviderAccountStatus | undefined,
  harness?: Provider,
): account is ProviderAccountStatus =>
  !!account &&
  (account.state !== "unknown" ||
    !!account.authMethod ||
    !!account.detail ||
    (harness === Provider.ANTIGRAVITY && !!account.loginExecutable));

const stateLabels = new Map([
  ["signed_in", "Signed in"],
  ["stored", "Login saved"],
  ["signed_out", "Not signed in"],
  ["error", "Check failed"],
]);

/** The account state in words; a turn's rejection ("expired") or a passed CLI expiry reads as expired. */
export function accountStateLabel(account: ProviderAccountStatus | undefined, now: number): string {
  if (account?.state === "expired") return "Sign-in expired";

  if (account?.expiresAt && Number(account.expiresAt.seconds) * 1000 <= now) return "Expired";

  return stateLabels.get(account?.state ?? "") ?? "";
}
