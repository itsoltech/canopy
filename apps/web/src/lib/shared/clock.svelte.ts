import { createSubscriber } from "svelte/reactivity";
import { subscribeTime } from "./ticker.ts";

/** Relative labels share a slow clock. It stops when unobserved or the document is hidden. */
class Clock {
  #subscribe = createSubscriber((update) => subscribeTime(update, 30_000));

  get now(): number {
    this.#subscribe();

    return Date.now();
  }
}

export const clock = new Clock();
