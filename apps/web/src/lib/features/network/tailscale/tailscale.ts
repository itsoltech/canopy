import type { ui } from "@canopy/contracts";
import type { Tone } from "#lib/shared/ui/tone.ts";

/** What each Tailscale state means for this computer (docs/tailscale.md). */
const STATES = new Map<string, { title: string; tone: Tone; description: string }>([
  [
    "not_installed",
    {
      title: "Not found",
      tone: "neutral",
      description: "Canopy can't find Tailscale on this computer. Install it to reach this computer by name.",
    },
  ],
  [
    "not_running",
    {
      title: "Not running",
      tone: "amber",
      description: "Start Tailscale on this computer to use its name and addresses.",
    },
  ],
  [
    "stopped",
    {
      title: "Turned off",
      tone: "amber",
      description: "Turn on Tailscale on this computer to use its name and addresses.",
    },
  ],
  [
    "logged_out",
    {
      title: "Signed out",
      tone: "amber",
      description: "Sign in to Tailscale on this computer to use its name and addresses.",
    },
  ],
  [
    "starting",
    { title: "Starting…", tone: "sky", description: "Tailscale is connecting this computer to its tailnet." },
  ],
]);

export function tailscaleState(status: ui.Tailscale) {
  if (status.state === "connected")
    return {
      title: "Connected",
      tone: "emerald" as const,
      description: status.tailnet
        ? `On the “${status.tailnet}” tailnet. Phones, computers and workers try its name first.`
        : "Phones, computers and workers try its name first.",
    };

  return STATES.get(status.state) ?? { title: status.state, tone: "neutral" as const, description: "" };
}

/** The HTTPS switch's one-sentence description: who can open Canopy there. */
export function httpsDescription(https: ui.TailscaleHttps) {
  return https.allowedLogin
    ? `Opens Canopy with a trusted certificate on devices signed in to Tailscale as ${https.allowedLogin}.`
    : "Opens Canopy with a trusted certificate on every device in your tailnet.";
}
