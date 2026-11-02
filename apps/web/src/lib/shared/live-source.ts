/**
 * An EventSource that never gives up. The browser retries by itself only after a network drop; a reply with an
 * error status (the BFF answers 502/503 while the gateway restarts) closes the source for good, which left the
 * page "reconnecting" until a reload. Here a closed source opens again after a growing delay (1 s, 2 s, … 15 s),
 * and so does one the server ended with a `failure` event. Every open after the first is a reconnect: the caller
 * resyncs then (`onopen(true)`).
 */
export interface LiveSourceHandlers {
  /** `reconnected`: not the first open, the caller missed what happened meanwhile. */
  readonly onopen?: (reconnected: boolean) => void;
  readonly onmessage: (data: string) => void;
  /** The stream dropped (it is being retried). */
  readonly ondrop?: () => void;
  /** The server reported the gateway stream failed (`event: failure`). */
  readonly onfailure?: () => void;
}

const MAX_DELAY_MS = 15_000;

export function liveSource(url: string, handlers: LiveSourceHandlers): () => void {
  let source: EventSource | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let opens = 0;
  let attempt = 0;

  const retry = () => {
    if (stopped || timer) return;
    source?.close();
    const delay = Math.min(MAX_DELAY_MS, 1000 * 2 ** attempt++);
    timer = setTimeout(() => {
      timer = undefined;
      open();
    }, delay);
  };

  const open = () => {
    if (stopped) return;
    const current = new EventSource(url);
    source = current;
    current.onopen = () => {
      attempt = 0;
      handlers.onopen?.(opens++ > 0);
    };
    current.onerror = () => {
      handlers.ondrop?.();
      if (current.readyState === EventSource.CLOSED) retry();
    };
    current.addEventListener("failure", () => {
      handlers.onfailure?.();
      retry();
    });
    current.onmessage = (message) => handlers.onmessage(message.data);
  };

  open();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    source?.close();
  };
}
