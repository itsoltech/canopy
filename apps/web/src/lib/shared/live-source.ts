export interface LiveSourceHandlers {
  /** The BFF confirmed gateway availability; every reopen needs a resync. */
  readonly onopen?: (reconnected: boolean, signal: AbortSignal) => void | Promise<void>;
  readonly onmessage: (data: string) => void;
  readonly ondrop?: () => void;
  readonly onfailure?: () => void;
}

export interface LiveSourceEnvironment {
  readonly source: (url: string) => EventSource;
  readonly hidden: () => boolean;
  readonly online: () => boolean;
  readonly random: () => number;
  readonly schedule: (run: () => void, delay: number) => () => void;
  readonly listen: (event: "focus" | "online" | "offline" | "visibilitychange", run: () => void) => () => void;
}

const browser: LiveSourceEnvironment = {
  source: (url) => new EventSource(url),
  hidden: () => document.hidden,
  online: () => navigator.onLine,
  random: Math.random,
  schedule: (run, delay) => {
    const timer = setTimeout(run, delay);
    return () => clearTimeout(timer);
  },
  listen: (event, run) => {
    const target = event === "visibilitychange" ? document : window;
    target.addEventListener(event, run);
    return () => target.removeEventListener(event, run);
  },
};

export function retryDelay(attempt: number, random: number): number {
  return Math.round(Math.min(15_000, 1000 * 2 ** Math.min(attempt, 4)) * (0.75 + 0.25 * random));
}

/** Own retries even for CONNECTING: browser retry policies differ after HTTP errors and proxy restarts. */
export function liveSource(url: string, handlers: LiveSourceHandlers, environment = browser): () => void {
  let source: EventSource | undefined;
  let connection: AbortController | undefined;
  let cancelRetry: (() => void) | undefined;
  let cancelWatchdog: (() => void) | undefined;
  let stopped = false;
  let opens = 0;
  let attempt = 0;
  let ready = false;

  const close = () => {
    connection?.abort();
    source?.close();
    source = undefined;
    ready = false;
    cancelWatchdog?.();
    cancelWatchdog = undefined;
  };

  const retry = (failed = false) => {
    if (stopped || cancelRetry) return;
    close();
    handlers.ondrop?.();
    if (failed || attempt >= 2) handlers.onfailure?.();
    if (environment.hidden() || !environment.online()) return;
    cancelRetry = environment.schedule(() => {
      cancelRetry = undefined;
      open();
    }, retryDelay(attempt++, environment.random()));
  };

  const heartbeat = () => {
    cancelWatchdog?.();
    cancelWatchdog = environment.schedule(() => retry(), 30_000);
  };

  const open = () => {
    if (stopped || environment.hidden() || !environment.online()) return;
    const current = environment.source(url);
    const abort = new AbortController();
    source = current;
    connection = abort;
    const active = () => !stopped && !abort.signal.aborted && source === current;
    heartbeat();
    // HTTP 200 alone proves nothing: the gateway may be down behind the BFF.
    current.addEventListener("ready", () => {
      if (!active() || ready) return;
      ready = true;
      heartbeat();
      const opened = async () => {
        await handlers.onopen?.(opens++ > 0, abort.signal);
        if (active()) attempt = 0;
      };
      void opened().catch(() => {
        if (active()) retry(true);
      });
    });
    current.addEventListener("heartbeat", () => {
      if (active()) heartbeat();
    });
    current.onerror = () => {
      if (active()) retry();
    };
    current.addEventListener("failure", () => {
      if (active()) retry(true);
    });
    current.onmessage = (message) => {
      if (!active()) return;
      heartbeat();
      handlers.onmessage(message.data);
    };
  };

  const resume = () => {
    if (environment.hidden() || !environment.online()) {
      cancelRetry?.();
      cancelRetry = undefined;
      if (!ready || !environment.online()) {
        if (source && !environment.online()) handlers.ondrop?.();
        close();
      }
      return;
    }
    if (source) return;
    cancelRetry?.();
    cancelRetry = undefined;
    open();
  };
  const unsubscribe = (["focus", "online", "offline", "visibilitychange"] as const).map((event) => environment.listen(event, resume));
  open();
  return () => {
    stopped = true;
    cancelRetry?.();
    close();
    for (const off of unsubscribe) off();
  };
}
