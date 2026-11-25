import type { DesktopObservation } from "./desktop-observation.ts";

const IMAGE_TTL_MS = 15_000;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;

interface Entry {
  observation: DesktopObservation;
  expiresAt: number;
  dispose: () => void;
}

/** Per-worker byte budget across sessions. Viewing an image never extends its original lifetime. */
export class DesktopObservationStore {
  readonly #entries = new Map<string, Entry>();
  readonly #notify: (session: string) => void;
  #bytes = 0;

  constructor(notify: (session: string) => void) {
    this.#notify = notify;
  }

  get(session: string) {
    const entry = this.#entries.get(session);

    if (!entry) return undefined;

    if (Date.now() >= entry.expiresAt) {
      this.clear(session);
      this.#notify(session);

      return undefined;
    }

    this.#entries.delete(session);
    this.#entries.set(session, entry);

    return entry.observation;
  }

  clear(session: string) {
    const entry = this.#entries.get(session);

    if (!entry) return false;
    this.#entries.delete(session);
    this.#bytes -= entry.observation.data.byteLength;
    entry.dispose();

    return true;
  }

  set(session: string, observation: DesktopObservation, signal: AbortSignal) {
    this.clear(session);
    const bytes = observation.data.byteLength;

    if (signal.aborted || bytes > MAX_TOTAL_BYTES) return;

    while (this.#bytes + bytes > MAX_TOTAL_BYTES) {
      const oldest = this.#entries.keys().next().value!;
      this.clear(oldest);
      this.#notify(oldest);
    }

    if (signal.aborted) return;

    const expire = () => {
      if (this.#entries.get(session)?.observation !== observation) return;
      this.clear(session);
      this.#notify(session);
    };

    const timer = setTimeout(expire, IMAGE_TTL_MS);
    timer.unref();
    this.#entries.set(session, {
      observation: Object.freeze(observation),
      expiresAt: Date.now() + IMAGE_TTL_MS,
      dispose: () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", expire);
      },
    });
    this.#bytes += bytes;
    signal.addEventListener("abort", expire, { once: true });
  }
}
