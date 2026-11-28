import { duration } from "#lib/shared/ui/motion.ts";
import { motionPreferences } from "#lib/shared/ui/motion-preferences.svelte.ts";
import { flushSync } from "svelte";
import type { FooterFold } from "../../../shared/ui/virtual/footer-reserve.ts";

type Publish = (compact: boolean, fold: FooterFold) => void;

interface HeldTransition {
  animation: CSSTransition;
  end: number;
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

  return { animation, end: Number(effect?.getComputedTiming().endTime ?? 0) };
}

/** One displayed progress for the whole fold, including reversals and interrupted settles. */
export class ComposerMorph {
  readonly #root: () => HTMLElement | undefined;
  readonly #publish: Publish;
  #progress = 0;
  #target = 0;
  #toward: boolean | undefined;
  #held: HeldTransition[] = [];
  #frame = 0;
  #lastFrame = 0;

  constructor(root: () => HTMLElement | undefined, publish: Publish) {
    this.#root = root;
    this.#publish = publish;
  }

  follow(progress: number) {
    this.#target = progress;

    if (motionPreferences.reduced) {
      if (progress === 0 || progress === 1) this.set(progress === 1);

      return;
    }

    if (this.#frame || this.#progress === progress) return;
    this.#lastFrame = performance.now();
    this.#frame = requestAnimationFrame(this.#advance);
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
    const delta = this.#target - this.#progress;

    if (!delta && this.#toward === undefined) return;

    if (motionPreferences.reduced) return this.set(this.#target >= 0.5);

    // Small scroll deltas track the reader directly. A wheel notch or a jump across the entire
    // end zone travels from the last painted position, at most one full fold per quick transition.
    const step = Math.max(0, now - this.#lastFrame) / duration("quick");
    this.#lastFrame = now;

    if (this.#toward === undefined) this.#start(this.#progress === 0);
    this.#progress = Math.abs(delta) <= step ? this.#target : this.#progress + Math.sign(delta) * step;

    const fraction = this.#toward ? this.#progress : 1 - this.#progress;

    for (const { animation, end } of this.#held) animation.currentTime = fraction * end;

    if (this.#progress !== this.#target) this.#frame = requestAnimationFrame(this.#advance);
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
