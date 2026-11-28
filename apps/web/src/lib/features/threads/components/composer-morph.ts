import { motionPreferences } from "#lib/shared/ui/motion-preferences.svelte.ts";
import { flushSync } from "svelte";
import type { FooterFold } from "../../../shared/ui/virtual/footer-reserve.ts";

type Publish = (compact: boolean, fold: FooterFold) => void;

interface HeldTransition {
  animation: Animation;
  end: number;
}

/** Decorative animations in the subtree keep their own playback, including infinite spinners. */
function pendingTransition(animation: Animation): boolean {
  return (
    animation instanceof CSSTransition &&
    animation.pending &&
    Number.isFinite(Number(animation.effect?.getComputedTiming().endTime))
  );
}

/** Pause once per scroll segment. Its length includes the delay so all transitions share the same progress. */
function holdTransition(animation: Animation): HeldTransition {
  const effect = animation.effect;

  if (effect && effect.getTiming().easing !== "linear") effect.updateTiming({ easing: "linear" });
  animation.playbackRate = 1;
  animation.pause();

  return { animation, end: Number(effect?.getComputedTiming().endTime ?? 0) };
}

/**
 * Folds and opens the composer with its own CSS transitions, either at their natural pace or held at
 * a scroll progress. Each change flips `compact` once; subsequent scroll frames only seek the
 * paused transitions. Under reduced motion the composer switches state only at either end.
 * The thread rows keep the feed's end reserve throughout.
 */
export class ComposerMorph {
  #root: () => HTMLElement | undefined;
  #publish: Publish;
  #compact = false;
  /** While moving: the state the running transitions lead to. */
  #toward: boolean | undefined;
  #animations: Animation[] = [];
  #held: HeldTransition[] | undefined;
  #frame = 0;
  #request: { progress: number } | { settle: boolean } | undefined;
  #run = 0;

  constructor(root: () => HTMLElement | undefined, publish: Publish) {
    this.#root = root;
    this.#publish = publish;
  }

  /** Holds the composer at scroll progress (0 full, 1 compact), applied in the next frame. */
  follow(progress: number) {
    this.#schedule({ progress });
  }

  /** Finishes in a state at the transitions' own pace, from wherever the composer is. */
  settle(compact: boolean) {
    if (this.#toward === undefined && this.#compact === compact && !this.#request) return;
    this.#schedule({ settle: compact });
  }

  /** Without motion (a thread opening as it was left). */
  set(compact: boolean) {
    this.#reset();
    this.#compact = compact;
    this.#publish(compact, compact ? "folded" : "open");
  }

  dispose() {
    this.#reset();
  }

  #reset() {
    cancelAnimationFrame(this.#frame);
    this.#frame = 0;
    this.#request = undefined;
    this.#run++;

    for (const animation of this.#animations) animation.cancel();
    this.#animations = [];
    this.#held = undefined;
    this.#toward = undefined;
  }

  #schedule(request: { progress: number } | { settle: boolean }) {
    this.#request = request;
    this.#frame ||= requestAnimationFrame(() => {
      this.#frame = 0;
      const next = this.#request;
      this.#request = undefined;

      if (next && "settle" in next) this.#settle(next.settle);
      else if (next) this.#hold(next.progress);
    });
  }

  #hold(progress: number) {
    if (motionPreferences.reduced) {
      if (progress >= 1 || progress <= 0) this.set(progress >= 1);

      return;
    }

    this.#run++;
    const toward = this.#toward ?? this.#leaving(progress);

    if (toward === undefined) return;

    if (this.#toward === undefined) this.#start(toward);
    const fraction = toward ? progress : 1 - progress;

    if (fraction >= 1) return this.#end(toward);

    if (fraction <= 0) return this.#end(!toward);

    const held = (this.#held ??= this.#animations.map(holdTransition));

    for (const { animation, end } of held) animation.currentTime = fraction * end;
  }

  /** The state a progress away from the current one leads to; undefined when it matches. */
  #leaving(progress: number): boolean | undefined {
    if (!this.#compact && progress > 0) return true;

    return this.#compact && progress < 1 ? false : undefined;
  }

  #settle(compact: boolean) {
    if (motionPreferences.reduced) return this.set(compact);

    if (this.#toward === undefined) {
      if (this.#compact === compact) return;
      this.#start(compact);
    }

    const run = ++this.#run;
    const forward = this.#toward === compact;
    this.#held = undefined;

    for (const animation of this.#animations) {
      animation.playbackRate = forward ? 1 : -1;
      animation.play();
    }

    void Promise.all(this.#animations.map((animation) => animation.finished)).then(
      () => run === this.#run && this.#end(compact),
      () => {},
    );
  }

  /** Flips the state once and keeps the transitions that flip started. */
  #start(compact: boolean) {
    this.#toward = compact;
    flushSync(() => this.#publish(compact, "moving"));
    // Reading the animations resolves style once: the transitions this flip started are still pending.
    this.#animations = (this.#root()?.getAnimations({ subtree: true }) ?? []).filter(pendingTransition);
  }

  #end(compact: boolean) {
    const animations = this.#animations;
    const reverted = compact !== this.#toward;
    this.#animations = [];
    this.#held = undefined;
    this.#toward = undefined;
    this.#compact = compact;
    flushSync(() => this.#publish(compact, compact ? "folded" : "open"));

    if (!reverted) {
      for (const animation of animations) animation.finish();

      return;
    }

    // Back where it started: the paused transitions and any reversal they cause end on the start values.
    for (const animation of animations) animation.cancel();

    for (const animation of this.#root()?.getAnimations({ subtree: true }) ?? [])
      if (pendingTransition(animation)) animation.cancel();
  }
}
