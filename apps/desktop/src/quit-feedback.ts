import type { QuitGuardState } from "@canopy/ui/desktop";

/** Preload subscribes before page code. Late Svelte mounts receive the latest state. */
export class QuitFeedback {
  private state: QuitGuardState | undefined;
  private readonly listeners = new Set<(state: QuitGuardState) => void>();
  private readonly renderers = new Set<(state: QuitGuardState) => void>();
  constructor(private readonly fallback: (state: QuitGuardState) => void) {}

  receive(state: QuitGuardState) {
    this.state = state;
    if (!this.renderers.size) this.fallback(state);
    for (const listener of this.listeners) listener(state);
  }

  subscribe(listener: (state: QuitGuardState) => void, rendersFeedback = true) {
    this.listeners.add(listener);
    if (rendersFeedback) this.renderers.add(listener);
    if (this.state) {
      this.fallback(this.renderers.size ? { ...this.state, phase: "cancel", durationMs: 0 } : this.state);
      listener(this.state);
    }
    return () => {
      this.listeners.delete(listener);
      this.renderers.delete(listener);
      if (!this.renderers.size && this.state) this.fallback(this.state);
    };
  }
}
