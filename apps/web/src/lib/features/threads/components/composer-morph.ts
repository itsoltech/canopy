import { duration, smoothOut } from "#lib/shared/ui/motion.ts";
import { motionPreferences } from "#lib/shared/ui/motion-preferences.svelte.ts";
import { flushSync } from "svelte";
import type { FooterFold } from "../../../shared/ui/virtual/footer-reserve.ts";

type Publish = (compact: boolean, fold: FooterFold) => void;

interface HeldTransition {
  animation: CSSTransition;
  end: number;
  fading: boolean;
}

/** Decorative animations in the subtree keep their own playback, including infinite spinners. */
function pendingTransition(animation: Animation): animation is CSSTransition {
  return (
    animation instanceof CSSTransition &&
    animation.pending &&
    Number.isFinite(Number(animation.effect?.getComputedTiming().endTime))
  );
}

/** Pause once per scroll segment. Its length includes the delay so all transitions share the same progress. */
function holdTransition(animation: CSSTransition): HeldTransition {
  const effect = animation.effect;

  if (effect && effect.getTiming().easing !== "linear") effect.updateTiming({ easing: "linear" });
  animation.pause();

  const fades = animation.transitionProperty === "opacity" || animation.transitionProperty === "filter";

  return {
    animation,
    end: Number(effect?.getComputedTiming().endTime ?? 0),
    fading:
      fades && effect instanceof KeyframeEffect && !!effect.target?.matches(".t-composer-fold > *, .t-composer-hint"),
  };
}

/** One displayed progress for the whole fold, including reversals and interrupted settles. */
export class ComposerMorph {
  readonly #root: () => HTMLElement | undefined;
  readonly #publish: Publish;
  #progress = 0;
  #target = 0;
  #from = 0;
  #started = 0;
  #toward: boolean | undefined;
  #held: HeldTransition[] = [];
  #frame = 0;
  #lastFrame = 0;

  constructor(root: () => HTMLElement | undefined, publish: Publish) {
    this.#root = root;
    this.#publish = publish;
  }

  follow(progress: number) {
    const sameTarget = this.#target === progress;
    this.#target = progress;

    if (motionPreferences.reduced) {
      if (progress === 0 || progress === 1) this.set(progress === 1);

      return;
    }

    if (sameTarget && (this.#frame || progress === this.#progress)) return;
    this.#from = this.#progress;

    // While scrolling, several targets can arrive between paints. Give the latest one the time
    // since the last frame, even when its scroll event arrived just before this frame's callback.
    if (!this.#frame) this.#lastFrame = performance.now();
    this.#started = this.#lastFrame;
    this.#frame ||= requestAnimationFrame(this.#advance);
  }

  settle(compact: boolean) {
    this.follow(compact ? 1 : 0);
  }

  /** A thread reopening at its saved position skips the fold entirely. */
  set(compact: boolean) {
    this.dispose();
    this.#target = this.#progress = compact ? 1 : 0;
    this.#publish(compact, compact ? "folded" : "open");
  }

  dispose() {
    cancelAnimationFrame(this.#frame);
    this.#frame = 0;

    for (const { animation } of this.#held) animation.cancel();
    this.#held = [];
    this.#toward = undefined;
  }

  #advance = (now: number) => {
    this.#frame = 0;
    const delta = this.#target - this.#from;

    if (!delta && this.#toward === undefined) return;

    if (motionPreferences.reduced) return this.set(this.#target >= 0.5);

    // A small gesture takes a fraction of a frame. Longer travel eases into the endpoint.
    const ms = Math.abs(delta) * duration(delta > 0 ? "medium" : "slow");
    const t = ms > 0 ? Math.min(1, Math.max(0, now - this.#started) / ms) : 1;
    this.#lastFrame = now;

    if (this.#toward === undefined) this.#start(this.#progress === 0);
    this.#progress = t === 1 ? this.#target : this.#from + delta * smoothOut(t);
    const fraction = this.#toward ? this.#progress : 1 - this.#progress;
    // Fade the controls before their row clips the labels. Reopening retraces the same dissolve.
    const dissolved = smoothOut(this.#progress);
    const fade = this.#toward ? dissolved : 1 - dissolved;

    for (const { animation, end, fading } of this.#held) animation.currentTime = (fading ? fade : fraction) * end;

    if (t < 1) this.#frame = requestAnimationFrame(this.#advance);
    else if (fraction === 0 || fraction === 1) this.#end(this.#progress === 1);
  };

  #start(compact: boolean) {
    this.#toward = compact;
    flushSync(() => this.#publish(compact, "moving"));
    const animations = this.#root()?.getAnimations({ subtree: true }) ?? [];
    this.#held = animations.filter(pendingTransition).map(holdTransition);
  }

  #end(compact: boolean) {
    const held = this.#held;
    const reverted = compact !== this.#toward;
    this.#held = [];
    this.#toward = undefined;
    flushSync(() => this.#publish(compact, compact ? "folded" : "open"));

    // Resolve the restored CSS state while its transitions are still held at their start values.
    // Canceling them first exposes the opposite endpoint and starts a second, unrequested fold.
    if (reverted) this.#root()?.getAnimations({ subtree: true });

    for (const { animation } of held) {
      if (reverted) animation.cancel();
      else animation.finish();
    }
  }
}
