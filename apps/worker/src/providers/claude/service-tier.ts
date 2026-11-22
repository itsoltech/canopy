import type { SDKControlInitializeResponse } from "@anthropic-ai/claude-agent-sdk";
import type { Session } from "./thread-types.ts";

export function claudeFastMode(serviceTier: string): boolean {
  if (serviceTier && serviceTier !== "default" && serviceTier !== "fast")
    throw new Error("The selected speed is unavailable for Claude.");

  return serviceTier === "fast";
}

/** Flag settings opt into SDK fast mode and override the restored session's speed. */
export async function configureClaudeSpeed(session: Session, serviceTier: string): Promise<void> {
  // The profiled process already has the chosen speed in its immutable startup settings.
  if (!session.sandboxProfileDigest) await session.query.applyFlagSettings({ fastMode: claudeFastMode(serviceTier) });

  if (serviceTier === "fast") {
    const initialized = await session.query.reinitialize();

    if (!claudeFastAvailable(initialized, session.model))
      throw new Error("Fast speed is unavailable for this model and account. Refresh the model list.");
  }

  session.serviceTier = serviceTier;
}

/** Both model support and the account's current entitlement must permit fast inference. */
export function claudeFastAvailable(initialized: SDKControlInitializeResponse, model: string): boolean {
  const selected = model || "default";

  const supported = initialized.models.some(
    (m) => (m.value === selected || m.resolvedModel === selected) && m.supportsFastMode === true,
  );

  return (
    supported &&
    !initialized.fast_mode_disabled_reason &&
    ["on", "cooldown"].includes(initialized.fast_mode_state ?? "")
  );
}
