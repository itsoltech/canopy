import { ConnectionRecovery, type RecoverySnapshot } from "@canopy/domain/connection-recovery";
import { readThreadWatchFailure, type ThreadWatchFailure } from "@canopy/domain/thread-watch-recovery";

export interface LiveSourceHandlers {
  /** Compute a fresh checkpoint on every retry. */
  readonly url?: () => string;
  /** The BFF confirmed gateway availability; every reopen needs a resync. */
  readonly onopen?: (reconnected: boolean, signal: AbortSignal) => void | Promise<void>;
  readonly onmessage: (data: string) => void;
  readonly ondrop?: () => void;
  readonly onfailure?: () => void;
  readonly onerror?: (failure: ThreadWatchFailure) => boolean;
  readonly onstatus?: (state: RecoverySnapshot) => void;
}

/** A resync was refused by a linked computer; the local gateway answered. */
export class ComputerAway extends Error {}

export interface LiveSourceEnvironment {
  readonly source: (url: string) => EventSource;
  readonly hidden: () => boolean;
  readonly online: () => boolean;
  readonly random: () => number;
  readonly schedule: (run: () => void, delay: number) => () => void;
  readonly listen: (
    event: "focus" | "online" | "offline" | "visibilitychange" | "canopy:reconnect",
    run: () => void,
  ) => () => void;
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

/** Own retries even for CONNECTING: browser retry policies differ after HTTP errors and proxy restarts. */
export function liveSource(url: string, handlers: LiveSourceHandlers, environment = browser): () => void {
  let source: EventSource | undefined;
  let connection: AbortController | undefined;
  let cancelRetry: (() => void) | undefined;
  let cancelWatchdog: (() => void) | undefined;
  let cancelFailure: (() => void) | undefined;
  let stopped = false;
  let opens = 0;
  const recovery = new ConnectionRecovery();
  let ready = false;
  let computerAway = false;

  const publish = () => {
    const state = recovery.snapshot;
    handlers.onstatus?.(state);

    if (state.status === "unavailable") handlers.onfailure?.();
  };

  const watchFailure = () => {
    cancelFailure ??= watchAvailability(recovery, environment, () => {
      cancelFailure = undefined;
      publish();
    });
  };

  const close = () => {
    connection?.abort();
    source?.close();
    source = undefined;
    ready = false;
    cancelWatchdog?.();
    cancelWatchdog = undefined;
  };

  const stop = () => {
    stopped = true;
    cancelFailure?.();
    cancelRetry?.();
    close();
  };

  const retry = (away = false) => {
    if (stopped || cancelRetry) return;
    close();
    computerAway = away;

    if (away) {
      cancelFailure?.();
      cancelFailure = undefined;
      recovery.succeeded();
      publish();
    } else {
      handlers.ondrop?.();
      recovery.failed(Date.now(), environment.random());
      publish();
      watchFailure();
    }

    if (environment.hidden() || !environment.online()) return;
    cancelRetry = environment.schedule(
      () => {
        cancelRetry = undefined;
        open();
      },
      Math.max(0, (recovery.snapshot.retryAt ?? Date.now() + 1000) - Date.now()),
    );
  };

  const heartbeat = () => {
    cancelWatchdog?.();
    cancelWatchdog = environment.schedule(() => retry(), 30_000);
  };

  const open = () => {
    if (stopped || environment.hidden() || !environment.online()) return;

    if (!computerAway) recovery.begin();
    publish();
    watchFailure();
    const current = environment.source(handlers.url?.() ?? url);
    const abort = new AbortController();
    source = current;
    connection = abort;
    const active = () => !stopped && !abort.signal.aborted && source === current;
    heartbeat();
    attachSource(current, {
      active,
      heartbeat,
      retry,
      onmessage: handlers.onmessage,
      onerror: handlers.onerror,
      stop,
      onready: async () => {
        if (ready) return;
        ready = true;
        heartbeat();
        await handlers.onopen?.(opens++ > 0, abort.signal);

        if (active()) {
          recovery.succeeded();
          publish();
          cancelFailure?.();
          cancelFailure = undefined;
        }
      },
    });
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
    recovery.resetBackoff();
    cancelRetry?.();
    cancelRetry = undefined;
    open();
  };

  const unsubscribe = listenRecovery(environment, resume, close);

  open();

  return () => {
    stop();

    for (const off of unsubscribe) off();
  };
}

function watchAvailability(recovery: ConnectionRecovery, environment: LiveSourceEnvironment, publish: () => void) {
  if (recovery.unavailableAt === undefined || recovery.snapshot.status === "unavailable") return undefined;

  return environment.schedule(
    () => {
      recovery.check();
      publish();
    },
    Math.max(0, recovery.unavailableAt - Date.now()),
  );
}

function listenRecovery(environment: LiveSourceEnvironment, resume: () => void, close: () => void) {
  return (["focus", "online", "offline", "visibilitychange", "canopy:reconnect"] as const).map((event) =>
    environment.listen(event, () => {
      if (event === "canopy:reconnect") close();
      resume();
    }),
  );
}

/** HTTP 200 alone proves nothing: only ready plus a completed resync confirms availability. */
function attachSource(
  source: EventSource,
  handlers: {
    active: () => boolean;
    heartbeat: () => void;
    retry: (away?: boolean) => void;
    onready: () => Promise<void>;
    onmessage: (data: string) => void;
    onerror: LiveSourceHandlers["onerror"];
    stop: () => void;
  },
) {
  source.addEventListener("ready", () => {
    if (!handlers.active()) return;
    void handlers.onready().catch((cause: unknown) => {
      if (handlers.active()) handlers.retry(cause instanceof ComputerAway);
    });
  });
  source.addEventListener("heartbeat", () => {
    if (handlers.active()) handlers.heartbeat();
  });

  const failed = (failure: ThreadWatchFailure) => {
    if (!handlers.active()) return;

    if (handlers.onerror?.(failure) === false) handlers.stop();
    else handlers.retry(failure.computer);
  };

  source.onerror = () => failed({ code: 14 });
  source.addEventListener("failure", (event) => failed(readThreadWatchFailure(event.data)));
  source.addEventListener("away", () => {
    failed({ code: 14, computer: true });
  });
  source.onmessage = (message) => {
    if (!handlers.active()) return;
    handlers.heartbeat();

    try {
      handlers.onmessage(message.data);
    } catch {
      failed({ code: 15 });
    }
  };
}
