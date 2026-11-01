import type { ui } from "@open-agents/contracts";
import type { MessageNote } from "./items/UserMessageView.svelte";

/** A message that joined the turn while the agent worked (delivered steer). */
export const STEERED: MessageNote = { icon: "arrow-turn-down-right", text: "Steered into this turn" };

/** A steer on its way: sent to the worker, or taken by the provider and waiting for the agent's next step. */
export const steeringNote = (steer: ui.Steer): MessageNote =>
  steer.status === "accepted" ? { icon: "arrow-turn-down-right", text: "Accepted, joins at the agent's next step" } : { icon: "spinner", text: "Steering into the running turn…" };

/** A queued turn's input; `fallback` = a steer that could not join the running turn and runs next instead. */
export function queuedNote(queued: boolean, fallback: ui.Steer | undefined): MessageNote | undefined {
  if (fallback) return { icon: "exclamation-circle", tone: "amber", text: `Could not join the running turn${fallback.reason ? ` (${fallback.reason})` : ""}, runs next` };
  return queued ? { icon: "clock", text: "Queued, runs after the current turn" } : undefined;
}
