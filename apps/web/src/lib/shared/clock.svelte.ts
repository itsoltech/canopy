/**
 * The current time for relative labels ("Working 12m", "3h"), ticking every 30 s in the browser so
 * lists age without a reload. On the server every read is the real time of the request.
 */
class Clock {
  #now = $state(Date.now());
  #started = false;

  get now(): number {
    if (typeof window === "undefined") return Date.now();
    if (!this.#started) {
      this.#started = true;
      setInterval(() => (this.#now = Date.now()), 30_000);
    }
    return this.#now;
  }
}

export const clock = new Clock();
