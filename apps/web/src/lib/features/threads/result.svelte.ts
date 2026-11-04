import type { ui } from "@canopy/contracts";
import { unseenResult, type TurnResult } from "./activity.ts";

/** How long a result stays shown after it was seen (the open thread's turn ends: "Completed" for a moment). */
const LINGER_MS = 4_000;

/**
 * The thread's unseen turn result, kept a few seconds after it was seen, so a turn that ends while you watch
 * still announces itself before the row settles. Call from a component's script (it sets up effects).
 */
export interface LingeringResult {
  readonly current: TurnResult | undefined;
}

export function lingeringResult(read: () => ui.Thread): LingeringResult {
  let shown = $state<TurnResult | undefined>(unseenResult(read()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const now = unseenResult(read());
    clearTimeout(timer);

    if (now) shown = now;
    else timer = setTimeout(() => (shown = undefined), LINGER_MS);
  });
  $effect(() => () => clearTimeout(timer));

  return {
    get current() {
      return shown;
    },
  };
}
