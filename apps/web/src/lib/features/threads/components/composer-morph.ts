import { flushSync } from "svelte";
import type { FooterFold } from "../../../shared/ui/virtual/footer-reserve.ts";

type Publish = (compact: boolean, fold: FooterFold) => void;

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The point in an animation's whole run (delay included) at this fraction, linear in the scroll. */
function seek(animation: Animation, fraction: number) {
  const timing = animation.effect?.getTiming();

  if (timing && timing.easing !== "linear") animation.effect?.updateTiming({ easing: "linear" });
  const end = Number(animation.effect?.getComputedTiming().endTime ?? 0);
  animation.playbackRate = 1;
  animation.pause();
  animation.currentTime = fraction * end;
}

/**
 * Folds and opens the composer with its own CSS transitions, either at their natural pace or held at
 * a scroll progress. Each change flips `compact` once; the transitions it starts are paused and
 * seeked on the compositor timeline, one write per frame. Under reduced motion the composer switches
 * state only at either end. The thread rows are not touched: the feed's end reserve stays.
 */
export class ComposerMorph {
  #root: () => HTMLElement | undefined;
  #publish: Publish;
  #compact = false;
  /** While moving: the state the running transitions lead to. */
  #toward: boolean | undefined;
  #animations: Animation[] = [];
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
    if (reducedMotion()) {
      if (progress >= 1 || progress <= 0) this.set(progress >= 1);

      return;
    }

    this.#run++;
    const toward = this.#toward ?? this.#leaving(progress);

    if (toward === undefined) return;

    if (this.#toward === undefined) this.#start(toward);
    const fraction = toward ? progress : 1 - progress;

    if (fraction >= 1) this.#end(toward);
    else if (fraction <= 0) this.#end(!toward);
    else for (const animation of this.#animations) seek(animation, fraction);
  }

  /** The state a progress away from the current one leads to; undefined when it matches. */
  #leaving(progress: number): boolean | undefined {
    if (!this.#compact && progress > 0) return true;

    return this.#compact && progress < 1 ? false : undefined;
  }

  #settle(compact: boolean) {
    if (reducedMotion()) return this.set(compact);

    if (this.#toward === undefined) {
      if (this.#compact === compact) return;
      this.#start(compact);
    }

    const run = ++this.#run;
    const forward = this.#toward === compact;

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
    this.#animations = (this.#root()?.getAnimations({ subtree: true }) ?? []).filter((animation) => animation.pending);
  }

  #end(compact: boolean) {
    const animations = this.#animations;
    const reverted = compact !== this.#toward;
    this.#animations = [];
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
      if (animation.pending) animation.cancel();
  }
}
