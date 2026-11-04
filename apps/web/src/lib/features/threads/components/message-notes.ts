import type { ui } from "@canopy/contracts";
import type { MessageNote } from "./items/UserMessageView.svelte";

/** A message that joined the turn while the agent worked (delivered steer). */
export const STEERED: MessageNote = { icon: "arrow-turn-down-right", text: "Steered into this turn" };

/** A steer on its way: sent to the worker, or taken by the provider and waiting for the agent's next step. */
export const steeringNote = (steer: ui.Steer): MessageNote =>
  steer.status === "accepted"
    ? { icon: "arrow-turn-down-right", text: "Accepted, joins at the agent's next step" }
    : { icon: "spinner", text: "Steering into the running turn…" };
